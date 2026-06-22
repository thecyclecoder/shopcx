/**
 * spec-card-state — the live, instant project-management mirror behind the roadmap board
 * (spec-card-db-companion). Supersedes the disabled roadmap-reads-specs-from-git.
 *
 * A card's status used to be parsed only from the spec markdown's phase emojis AS BUNDLED IN THE
 * DEPLOYED BUILD, so a merge / drift flip / owner mark didn't show until a markdown edit + commit +
 * Vercel deploy. This module is the read/write layer over the `spec_card_state` table: the merge,
 * drift, owner-flip, and build paths write it the moment the event happens, and the board reads it
 * DB-first (falling back to the markdown-parsed status when no row exists).
 *
 * Canonical-source rule: the MARKDOWN stays canonical for spec content + the durable phase record;
 * this is only the board mirror + transient flags (deploy_pending, blocked). The board takes whichever
 * of (markdown, this) is FURTHER ALONG — so this only ever moves a card forward, a markdown that's
 * already ahead (a redeploy / owner edit) wins, and there's never a permanent divergence (the
 * spec-drift reconciler + the fold keep the two in sync). See docs/brain/tables/spec_card_state.md.
 *
 * All writes are best-effort: a mirror-write failure must never break the underlying merge / flip /
 * build path, so every writer swallows its error (the daily spec-drift reconcile is the backstop).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { Phase } from "@/lib/brain-roadmap";

export interface SpecCardPhaseState {
  index: number; // 0-based, matches the board parser order
  title: string;
  status: Phase;
}

/** Transient board flags that don't belong in committed markdown. */
export interface SpecCardFlags {
  deploy_pending?: boolean; // merged code not yet known-live (cleared at read time by the SHA compare)
  blocked?: boolean;
  [k: string]: boolean | undefined;
}

export interface SpecCardState {
  workspace_id: string;
  spec_slug: string;
  status: Phase;
  phase_states: SpecCardPhaseState[];
  flags: SpecCardFlags;
  last_merge_sha: string | null;
  updated_at: string;
}

const PHASE_RANK: Record<Phase, number> = { rejected: -1, planned: 0, in_progress: 1, shipped: 2 };

/**
 * Roll a per-phase snapshot up to a single board status (chain-and-cardstate-under-automerge Phase 1, Bug A).
 * all shipped → shipped (a `rejected`/cut phase doesn't block, mirroring the markdown deriveStatus); any
 * shipped/in_progress but not all → in_progress; else planned. Empty → planned.
 *
 * This is what a MERGE-write must store, NOT the H1-emoji-derived status: when 1 of N "Build all" phases has
 * merged, `phase_states[0]="shipped"` but the spec's ⏳ title would derive `planned` — and since the board
 * takes max(markdownStatus, state.status), a `planned` state can't lift the card off Planned. Rolling the
 * phase_states up instead flips the card to In progress the moment the first phase ships.
 */
export function rollupPhaseStatus(phaseStates: SpecCardPhaseState[] | undefined): Phase {
  const phases = phaseStates ?? [];
  if (!phases.length) return "planned";
  const planned = phases.filter((p) => p.status === "planned").length;
  const inProgress = phases.filter((p) => p.status === "in_progress").length;
  const shipped = phases.filter((p) => p.status === "shipped").length;
  if (planned === 0 && inProgress === 0) return "shipped"; // every phase shipped (cut phases ignored)
  if (shipped > 0 || inProgress > 0) return "in_progress";
  return "planned";
}

/** Every spec_card_state row for a workspace, keyed by spec slug — the board's DB-first read. */
export async function getSpecCardStates(workspaceId: string): Promise<Record<string, SpecCardState>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_card_state")
    .select("workspace_id, spec_slug, status, phase_states, flags, last_merge_sha, updated_at")
    .eq("workspace_id", workspaceId);
  const out: Record<string, SpecCardState> = {};
  for (const r of (data ?? []) as SpecCardState[]) out[r.spec_slug] = r;
  return out;
}

/**
 * Resolve the status the board should show: the DB mirror is the instant signal, the markdown bundle
 * lags by a deploy, so take whichever is FURTHER ALONG. DB-first (it's how a just-merged card flips
 * shipped before the redeploy); but a markdown that's already ahead — a fresh deploy or an owner edit —
 * wins (markdown stays canonical). `rejected` is a phase-level state, never a whole-spec board column.
 */
export function resolveBoardStatus(markdownStatus: Phase, state: SpecCardState | undefined): Phase {
  if (!state || markdownStatus === "rejected") return markdownStatus;
  return PHASE_RANK[state.status] > PHASE_RANK[markdownStatus] ? state.status : markdownStatus;
}

export type DeployState = "deploying" | "live";

/**
 * The "shipped · deploying" vs "shipped · live" signal for a shipped card — clean, no webhook
 * (spec-card-db-companion). The merge that shipped this card has commit `last_merge_sha`; the live app
 * exposes its own deployed SHA (VERCEL_GIT_COMMIT_SHA). The merged code is LIVE once a deployment
 * carrying that SHA is up — detected when either the deployed SHA IS the merge SHA, or a later deploy
 * already carries the flipped emoji in its bundle (so the markdown the board parsed reads shipped).
 * Until then the merge isn't live yet → `deploying`. Returns null for a card that isn't shipped / has
 * no row / no merge SHA (no chip). `deployedSha` is "" locally — then the bundle (markdownStatus) decides.
 */
export function deploymentState(
  state: SpecCardState | undefined,
  markdownStatus: Phase,
  deployedSha: string,
): DeployState | null {
  if (!state || state.status !== "shipped" || !state.last_merge_sha) return null;
  if (state.flags?.deploy_pending === false) return "live"; // explicitly cleared
  const sha = (deployedSha || "").trim();
  const live = (!!sha && sha === state.last_merge_sha) || markdownStatus === "shipped";
  return live ? "live" : "deploying";
}

/** Upsert one (workspace, slug) row, MERGE-patching the `flags` jsonb (read-modify-write; best-effort). */
async function upsertCardState(
  workspaceId: string,
  slug: string,
  patch: { status?: Phase; phase_states?: SpecCardPhaseState[]; last_merge_sha?: string | null; flags?: SpecCardFlags },
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("spec_card_state")
      .select("flags")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .maybeSingle();
    const mergedFlags: SpecCardFlags = { ...((existing?.flags as SpecCardFlags) ?? {}), ...(patch.flags ?? {}) };
    const row: Record<string, unknown> = {
      workspace_id: workspaceId,
      spec_slug: slug,
      flags: mergedFlags,
      updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.phase_states !== undefined) row.phase_states = patch.phase_states;
    if (patch.last_merge_sha !== undefined) row.last_merge_sha = patch.last_merge_sha;
    await admin.from("spec_card_state").upsert(row, { onConflict: "workspace_id,spec_slug" });
  } catch {
    /* best-effort mirror — never break the underlying merge/flip/build path; the reconcile cron backstops */
  }
}

/**
 * Mirror a spec's derived status + per-phase snapshot to the board (drift reconciler / owner status flip /
 * one-tap drift flip). Instant — no markdown deploy wait. Does NOT touch deploy_pending / last_merge_sha.
 */
export async function markSpecCardStatus(
  workspaceId: string,
  slug: string,
  status: Phase,
  phaseStates?: SpecCardPhaseState[],
): Promise<void> {
  await upsertCardState(workspaceId, slug, { status, phase_states: phaseStates });
}

/**
 * Mirror a just-MERGED build: the card flips to its post-merge status instantly, tagged `deploy_pending`
 * with the merge commit SHA so the board can show "shipped · deploying" until a deployment carrying that
 * SHA is live (then deploymentState() reads it as "live" — no write needed to clear).
 */
export async function markSpecCardMergeShipped(
  workspaceId: string,
  slug: string,
  opts: { status: Phase; mergeSha: string | null; phaseStates?: SpecCardPhaseState[] },
): Promise<void> {
  // Bug A (chain-and-cardstate-under-automerge): the merge-write's status is the ROLLUP of phase_states, not
  // the caller's H1-emoji-derived `status` — so a 1-of-N-phases-merged "Build all" card flips to In progress
  // instead of staying stale Planned. Fall back to `opts.status` only when no per-phase snapshot is supplied
  // (nothing to roll up — e.g. a phase-less spec).
  const status = opts.phaseStates && opts.phaseStates.length ? rollupPhaseStatus(opts.phaseStates) : opts.status;
  await upsertCardState(workspaceId, slug, {
    status,
    phase_states: opts.phaseStates,
    last_merge_sha: opts.mergeSha,
    flags: { deploy_pending: true },
  });
}

/** Set/clear the `blocked` transient flag (spec-blockers — a spec gated behind an uncleared prerequisite). */
export async function markSpecCardBlocked(workspaceId: string, slug: string, blocked: boolean): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { blocked } });
}
