/**
 * spec-card-state — the AUTHORITATIVE project-management state behind the roadmap board.
 *
 * spec-status-db-driven (2026-06-24): status / per-phase status / **Priority:** critical / **Deferred:**
 * parked all live here, not in the spec markdown. Every status writer (owner flip, build merge, drift
 * reconciler, Ada drift-supervise, priority/defer) writes this row + an audit entry to
 * [[spec_status_history]] — zero markdown commits, zero deploys for status.
 *
 * Boolean flags `critical` and `deferred` live on the existing `flags` jsonb column (no schema change
 * needed for them — `flags.critical` / `flags.deferred`). The `status` column carries the phase rollup
 * (planned/in_progress/shipped/rejected); the `deferred` flag wins for display via
 * `effectiveStatusFromState`, so un-defer restores the underlying phase progress automatically.
 *
 * All writes are best-effort: a mirror-write failure must never break the underlying merge / flip /
 * build path, so every writer swallows its error (the daily spec-drift reconcile is the backstop).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { Phase, SpecStatus } from "@/lib/brain-roadmap";

export interface SpecCardPhaseState {
  index: number; // 0-based, matches the board parser order
  title: string;
  status: Phase;
}

/**
 * Transient board flags. spec-status-db-driven Phase 1 added `critical` (the **Priority:** flag) and
 * `deferred` (the parked flag) here so we don't need a schema change to host them — the existing
 * `flags` jsonb merges patches read-modify-write, so a critical/deferred toggle and the existing
 * deploy_pending/blocked flags compose cleanly.
 */
export interface SpecCardFlags {
  deploy_pending?: boolean; // merged code not yet known-live (cleared at read time by the SHA compare)
  blocked?: boolean;
  critical?: boolean; // **Priority:** critical — orthogonal to status (spec-status-db-driven Phase 1)
  deferred?: boolean; // **Deferred:** parked — wins over phase progress for display (Phase 1)
  [k: string]: boolean | undefined;
}

export interface SpecCardState {
  workspace_id: string;
  spec_slug: string;
  status: SpecStatus;
  phase_states: SpecCardPhaseState[];
  flags: SpecCardFlags;
  last_merge_sha: string | null;
  updated_at: string;
}

const PHASE_RANK: Record<Phase, number> = { rejected: -1, planned: 0, in_progress: 1, shipped: 2 };

/**
 * Roll a spec's per-phase states up to ONE board status — the same shape `deriveStatus` uses for markdown,
 * but driven purely by the phases (never the H1 emoji). All phases ✅ → `shipped`; any ✅/🚧 but not all →
 * `in_progress`; otherwise `planned`. `rejected` (a cut phase) is ignored — it never blocks shipped and an
 * all-cut spec rolls up to `planned`. Used by the merge-write so a part-shipped spec whose H1 is still ⏳
 * reads `in_progress`, not `planned` (chain-and-cardstate-under-automerge Bug A). Returns `planned` for an
 * empty phase set — callers with no phases fall back to the markdown-derived status instead.
 */
export function rollupPhaseStatus(phaseStates: SpecCardPhaseState[]): Phase {
  const relevant = phaseStates.filter((p) => p.status !== "rejected");
  if (!relevant.length) return "planned";
  if (relevant.every((p) => p.status === "shipped")) return "shipped";
  if (relevant.some((p) => p.status === "shipped" || p.status === "in_progress")) return "in_progress";
  return "planned";
}

/**
 * Forward-merge the markdown-parsed phases with the DB mirror's per-phase states: each phase shows whichever
 * source is MORE advanced (planned < in_progress < shipped), matched by index. So the board reflects per-phase
 * progress from the DB mirror INSTANTLY on each phase's merge — no waiting for the markdown bundle to redeploy —
 * and neither stale source ever regresses a phase. The board's overall column already uses resolveBoardStatus;
 * this is the same DB-first treatment for the per-phase checkmarks (fixes phases reading stale during a build).
 */
export function mergePhaseStates<T extends { status: Phase }>(markdownPhases: T[], state: SpecCardState | undefined): T[] {
  if (!state?.phase_states?.length) return markdownPhases;
  const byIndex = new Map(state.phase_states.map((p) => [p.index, p.status]));
  return markdownPhases.map((p, i) => {
    const dbStatus = byIndex.get(i);
    return dbStatus !== undefined && PHASE_RANK[dbStatus] > PHASE_RANK[p.status] ? { ...p, status: dbStatus } : p;
  });
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
 *
 * spec-status-db-driven Phase 1: also honors the DB `flags.deferred` flag — set means deferred wins for
 * display, regardless of `state.status` (the rollup), so an un-defer reveals the underlying phase progress.
 */
export function resolveBoardStatus(markdownStatus: SpecStatus, state: SpecCardState | undefined): SpecStatus {
  if (!state || markdownStatus === "rejected") return markdownStatus;
  // spec-status-db-driven Phase 1: the DB `flags.deferred` flag wins for display — overrides the
  // phase-progress rollup AND a stale markdown that's already promoted past Deferred.
  if (state.flags?.deferred) return "deferred";
  // A deferral coming from the markdown (the `**Deferred:**` marker) wins until the DB flag is set.
  if (markdownStatus === "deferred") return markdownStatus;
  // The DB `status` column never stores 'deferred' (the parking signal lives on flags.deferred), so the
  // remaining values are all `Phase` and PHASE_RANK indexes cleanly.
  const dbStatus = state.status as Phase;
  const mdStatus = markdownStatus as Phase;
  return PHASE_RANK[dbStatus] > PHASE_RANK[mdStatus] ? dbStatus : markdownStatus;
}

/**
 * Effective board status from the DB row alone — the DB-only read used by callers that don't have a
 * markdown view (`/api/roadmap/status` confirm payload, programmatic readers). `flags.deferred` wins;
 * otherwise the rollup `status`. Returns 'planned' for a missing row (first-render before any write).
 * spec-status-db-driven Phase 1.
 */
export function effectiveStatusFromState(state: SpecCardState | undefined): SpecStatus {
  if (!state) return "planned";
  if (state.flags?.deferred) return "deferred";
  return state.status;
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
  markdownStatus: SpecStatus,
  deployedSha: string,
): DeployState | null {
  if (!state || state.status !== "shipped" || !state.last_merge_sha) return null;
  if (state.flags?.deploy_pending === false) return "live"; // explicitly cleared
  const sha = (deployedSha || "").trim();
  const live = (!!sha && sha === state.last_merge_sha) || markdownStatus === "shipped";
  return live ? "live" : "deploying";
}

/** Who/why for a `spec_status_history` row. `field='phase'` uses `phaseIndex`; the others ignore it. */
export interface HistoryEntry {
  field: "status" | "phase" | "critical" | "deferred";
  phaseIndex?: number;
  actor: string;
  reason?: string;
}

/** Upsert one (workspace, slug) row, MERGE-patching the `flags` jsonb (read-modify-write; best-effort).
 * Optionally appends per-transition rows to `spec_status_history` for the audit ledger
 * (spec-status-db-driven Phase 1). The history write itself is best-effort — never blocks the upsert. */
async function upsertCardState(
  workspaceId: string,
  slug: string,
  patch: { status?: SpecStatus; phase_states?: SpecCardPhaseState[]; last_merge_sha?: string | null; flags?: SpecCardFlags },
  history?: HistoryEntry[],
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("spec_card_state")
      .select("flags, status, phase_states")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .maybeSingle();
    const priorFlags = (existing?.flags as SpecCardFlags) ?? {};
    const mergedFlags: SpecCardFlags = { ...priorFlags, ...(patch.flags ?? {}) };
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

    if (history && history.length) {
      const prior = {
        status: (existing?.status as SpecStatus | undefined),
        flags: priorFlags,
        phase_states: (existing?.phase_states as SpecCardPhaseState[] | undefined) ?? [],
      };
      const rows = history
        .map((h) => buildHistoryRow(workspaceId, slug, h, patch, prior))
        .filter((r): r is HistoryRow => r !== null);
      if (rows.length) {
        // Best-effort: a missing audit table (migration not applied yet) is swallowed silently —
        // the upsert above already landed; we don't break the flip on a missing ledger.
        await admin.from("spec_status_history").insert(rows).then(undefined, () => {});
      }
    }
  } catch {
    /* best-effort mirror — never break the underlying merge/flip/build path; the reconcile cron backstops */
  }
}

interface HistoryRow {
  workspace_id: string;
  spec_slug: string;
  field: HistoryEntry["field"];
  phase_index: number | null;
  from_value: string | null;
  to_value: string;
  actor: string;
  reason: string | null;
}

function buildHistoryRow(
  workspaceId: string,
  slug: string,
  h: HistoryEntry,
  patch: { status?: SpecStatus; flags?: SpecCardFlags; phase_states?: SpecCardPhaseState[] },
  prior: { status?: SpecStatus; flags: SpecCardFlags; phase_states: SpecCardPhaseState[] },
): HistoryRow | null {
  const make = (from: unknown, to: unknown, phaseIndex: number | null = null): HistoryRow | null => {
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return null;
    return {
      workspace_id: workspaceId,
      spec_slug: slug,
      field: h.field,
      phase_index: phaseIndex,
      from_value: from === undefined ? null : JSON.stringify(from),
      to_value: JSON.stringify(to ?? null),
      actor: h.actor,
      reason: h.reason ?? null,
    };
  };
  if (h.field === "status" && patch.status !== undefined) return make(prior.status, patch.status);
  if (h.field === "critical" && patch.flags?.critical !== undefined) return make(prior.flags.critical, patch.flags.critical);
  if (h.field === "deferred" && patch.flags?.deferred !== undefined) return make(prior.flags.deferred, patch.flags.deferred);
  if (h.field === "phase" && patch.phase_states && h.phaseIndex !== undefined) {
    const before = prior.phase_states.find((p) => p.index === h.phaseIndex)?.status;
    const after = patch.phase_states.find((p) => p.index === h.phaseIndex)?.status;
    return make(before, after, h.phaseIndex);
  }
  return null;
}

/**
 * Mirror a spec's derived status + per-phase snapshot to the board (drift reconciler / owner status flip /
 * one-tap drift flip). Instant — no markdown deploy wait. Does NOT touch deploy_pending / last_merge_sha.
 * Pass an `audit` (actor + optional reason) to record the transition in `spec_status_history`.
 */
export async function markSpecCardStatus(
  workspaceId: string,
  slug: string,
  status: SpecStatus,
  phaseStates?: SpecCardPhaseState[],
  audit?: { actor: string; reason?: string },
): Promise<void> {
  const history: HistoryEntry[] | undefined = audit
    ? [{ field: "status", actor: audit.actor, reason: audit.reason }]
    : undefined;
  await upsertCardState(workspaceId, slug, { status, phase_states: phaseStates }, history);
}

/** spec-status-db-driven Phase 1: set/clear the **Priority:** critical flag on the DB mirror (was a
 * markdown commit pre-refactor). Instant — no deploy. Audits the transition when `audit` is supplied. */
export async function markSpecCardCritical(
  workspaceId: string,
  slug: string,
  critical: boolean,
  audit: { actor: string; reason?: string },
): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { critical } }, [{ field: "critical", actor: audit.actor, reason: audit.reason }]);
}

/** spec-status-db-driven Phase 1: set/clear the **Deferred:** parked flag on the DB mirror (was a
 * markdown commit pre-refactor). Instant — no deploy. Un-deferring keeps the underlying `status` /
 * `phase_states` intact, so progress is preserved. Audits the transition. */
export async function markSpecCardDeferred(
  workspaceId: string,
  slug: string,
  deferred: boolean,
  audit: { actor: string; reason?: string },
): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { deferred } }, [{ field: "deferred", actor: audit.actor, reason: audit.reason }]);
}

/**
 * Mirror a just-MERGED build: the card flips to its post-merge status instantly, tagged `deploy_pending`
 * with the merge commit SHA so the board can show "shipped · deploying" until a deployment carrying that
 * SHA is live (then deploymentState() reads it as "live" — no write needed to clear).
 *
 * Bug A (chain-and-cardstate-under-automerge): the status it stores is the ROLLUP of `phaseStates`, never
 * the caller's title-derived `opts.status`. A multi-phase spec whose first phase shipped but whose H1 is
 * still ⏳ derives `planned` from the markdown (the title wins in `deriveStatus`), which parked a
 * part-shipped card in Planned. The phase rollup reads it correctly as `in_progress`. `opts.status` is the
 * fallback only when no phaseStates are supplied (a spec with no parsed phases — there the markdown status
 * is right).
 */
export async function markSpecCardMergeShipped(
  workspaceId: string,
  slug: string,
  opts: { status: SpecStatus; mergeSha: string | null; phaseStates?: SpecCardPhaseState[] },
): Promise<void> {
  const status = opts.phaseStates && opts.phaseStates.length ? rollupPhaseStatus(opts.phaseStates) : opts.status;
  const actor = `merge:${opts.mergeSha ?? ""}`;
  const phaseIndices = (opts.phaseStates ?? []).map((p) => p.index);
  const history: HistoryEntry[] = [
    { field: "status", actor, reason: "build merged on main" },
    ...phaseIndices.map((i) => ({ field: "phase" as const, phaseIndex: i, actor, reason: "build merged on main" })),
  ];
  await upsertCardState(
    workspaceId,
    slug,
    {
      status,
      phase_states: opts.phaseStates,
      last_merge_sha: opts.mergeSha,
      flags: { deploy_pending: true },
    },
    history,
  );
}

/** Set/clear the `blocked` transient flag (spec-blockers — a spec gated behind an uncleared prerequisite). */
export async function markSpecCardBlocked(workspaceId: string, slug: string, blocked: boolean): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { blocked } });
}
