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
  // Provenance (db-driven-status-trust-the-merge): the PR # + merge commit SHA that SHIPPED this phase.
  // A phase is `shipped` because a specific build PR merged it — this records WHICH, so the status is
  // provable/auditable, not inferred. Set when the merge hook ships the phase; absent on a planned phase.
  pr?: number | null;
  merge_sha?: string | null;
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
  /**
   * director-dismiss-park-and-short-circuit-spec Phase 2 — a shipped card closed CLEANLY without all phases
   * shipping ("we changed our mind, this isn't needed anymore"). Orthogonal to the rollup `status` (which the
   * director flips to `shipped` in the same action). The board reads this flag to render the card as
   * "shipped + short-circuited" with `short_circuit_reason` in a sub-line, so a reader doesn't think we
   * actually built it. Reversible: an owner flip back to `planned` (or a director short-circuit=false action)
   * clears both fields.
   */
  short_circuit?: boolean;
  /** The director's reason for the short-circuit — rendered as the card sub-line. Paired with `short_circuit=true`. */
  short_circuit_reason?: string;
  /**
   * spec-status-phase-pr-provenance Phase 1 — the card-level shipping PR for a **one-shot spec** (a spec
   * with zero `## Phase` sections, where the whole spec ships in ONE PR). Multi-phase specs record the
   * provenance per-phase in `phase_states[i].{pr,merge_sha}` instead; this slot is for the no-phase shape
   * only (the board reads it for the card's "✓ #PR" chip). Paired with `last_merge_sha` (already set).
   */
  merged_pr?: number;
  /**
   * spec-review-agent Phase 3 — the AUTHOR'S intended destination at spec creation: where they'd like
   * the spec to land once Vale clears it. A SUGGESTION, not binding — Ada (the director) disposes, with
   * an asymmetric check vs this signal (same → autonomous, UPGRADE → CEO-gated, DOWNGRADE → autonomous
   * + notify). Captured by every spec-creation surface on first write of the card row (planner,
   * triage, fix-spec builders, director split/author, Ada/coach). Lives on the DB, NEVER in the
   * markdown — "the database is the spec." Cleared once disposition completes (the spec leaves in_review).
   */
  intended_status?: "planned" | "deferred";
  /**
   * spec-review-agent Phase 3 — Vale's quality verdict on this spec: `true` iff she ran the CHECKLIST
   * and the spec passed (well-formed). A `vale_pass=true` spec is ready for Ada's disposition lane;
   * a missing/`false` flag (or `vale_pass` set after a needs_fix bounce) means Ada must not dispose yet.
   * Cleared on a status flip out of in_review (the disposition has landed, the flag is consumed).
   */
  vale_pass?: boolean;
  /**
   * build-gate-durable-review-signal — the DURABLE counterpart to the transient `vale_pass`. Set to `true`
   * alongside `vale_pass` on a Vale PASS (`markSpecCardValePassed`); UNLIKE `vale_pass` it is NOT consumed by
   * Ada's disposition (`applyAdaDisposition` / `markSpecCardPendingUpgrade` leave it intact), so it survives
   * the spec leaving `in_review`. Mirrors to `specs.vale_review_passed_at` (true → now(), false → null) via
   * `dualWriteSpecRow`. Cleared (set `false`) on a send-back / re-author (`markSpecCardBackToReview`) so a
   * materially-changed spec must be re-reviewed. The claim-time build gate reads the persisted timestamp as
   * its review-passed signal, never the consumed `vale_pass`. Write-only here (the board doesn't render it);
   * absent from a patch = untouched, exactly so the disposition writers don't have to carry it.
   */
  vale_review_passed?: boolean;
  /**
   * spec-review-agent Phase 3 — Ada's disposition record (per-spec, one shot). Set when she autonomously
   * applies a decision OR when she opens a gated proposal to the CEO. The board reads this to know that
   * the disposition lane has already touched a Vale-passed spec and the same Ada pass should NOT re-touch
   * it (dedupe). Cleared when the spec leaves in_review (the lane is consumed).
   */
  ada_disposition?: "autonomous_same" | "autonomous_downgrade" | "pending_upgrade";
  /**
   * vale-reasons-the-disposition Phase 1 — Vale's reasoned planned/deferred recommendation on a PASS.
   * Set alongside `vale_pass` by `markSpecCardValePassed` when the review pass carries a disposition;
   * absent for a legacy pass (the sweep falls back to `intended_status` in Phase 2). Ada's disposition
   * sweep (`adaDispositionFor`) will consume it in Phase 2 — retiring the trust-the-author stub.
   * Cleared on send-back / re-author alongside `vale_pass`.
   */
  vale_disposition?: "planned" | "deferred";
  /** vale-reasons-the-disposition Phase 1 — plain-text WHY paired with `vale_disposition`. Surfaced by
   *  Ada's asymmetric routing on the CEO Approval Request (UPGRADE) / notification (DOWNGRADE). */
  vale_disposition_reason?: string;
  [k: string]: boolean | string | number | undefined;
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
 * specs-status-override-only — the set of statuses that may be PERSISTED to the override-only `specs.status`
 * column. A spec's planned/in_progress/in_testing/shipped/rejected axis is PURELY DERIVED from the phase
 * rollup ([[brain-roadmap]] `deriveSpecCardStatus`), so those values must NEVER land in the stored column —
 * a derived destination clears it to NULL. Only the two NON-DERIVABLE lifecycle overrides survive:
 *   - deferred  — CEO parked it (also mirrored on `specs.deferred`).
 *   - folded    — archived after a fold.
 * `in_review` is NO LONGER an override (specs-status-overrides-only migration
 * 20260907130000_specs_status_overrides_only_derive_in_review): it is DERIVED at read time from the phase
 * rollup + `vale_review_passed_at` (`deriveSpecCardStatus`), so a stale stored `in_review` can never pin a
 * built spec in the In Review column again — every writer that passes `status:'in_review'` now maps to NULL
 * through this predicate. `in_testing` is likewise a read-time derivation (never stored). The CEO rule:
 * "there is only derived status" for everything except deferred/folded (a stored `planned` is the
 * noop-pipeline-test-4 bug).
 */
export function isOverrideStatus(status: string | null | undefined): boolean {
  return status === "deferred" || status === "folded";
}

// spec-readers-from-db-retire-parser Phase 3: `mergePhaseStates` is RETIRED. Per-phase status + PR/merge_sha
// provenance are now authoritative on `public.spec_phases` and flow straight onto `SpecCard.phases` via
// brain-roadmap `dbRowToSpecCard`; the spec-detail page reads `spec.card.phases` directly (no overlay onto the
// retired `spec_card_state.phase_states` slot).

/** Every spec_card_state row for a workspace, keyed by spec slug — the board's DB-first read. */
export async function getSpecCardStates(workspaceId: string): Promise<Record<string, SpecCardState>> {
  // spec-read-eff-pool — Phase 2 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
  // Pooled straggler read — one pooled query strips the PostgREST preamble off the full-workspace
  // scan every board render fires. `null` = pool unavailable / query error → fall through to the
  // supabase-js `.from()` path (same fail-open contract as [[pg-pool]] `getSpecWithPhases`).
  let rows: SpecCardState[] | null = null;
  try {
    const { listSpecCardStates } = await import("@/lib/pg-pool");
    const pooled = await listSpecCardStates<SpecCardState>(workspaceId);
    if (pooled !== null) rows = pooled;
  } catch {
    /* fall through to supabase-js .from() */
  }
  if (rows === null) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("spec_card_state")
      .select("workspace_id, spec_slug, status, phase_states, flags, last_merge_sha, updated_at")
      .eq("workspace_id", workspaceId);
    rows = (data ?? []) as SpecCardState[];
  }
  const out: Record<string, SpecCardState> = {};
  for (const r of rows) out[r.spec_slug] = r;
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
 * (spec-status-db-driven Phase 1). The history write itself is best-effort — never blocks the upsert.
 *
 * spec-authoring-writes-db-and-worker-materialize Phase 3 — DUAL-WRITE to `public.specs`. Every
 * spec-card-state status/flag flip ALSO writes the corresponding typed column on the future-canonical
 * `public.specs` row (status, deferred, priority, intended_status). The mirror stays the READ-path
 * until [[../specs/spec-readers-from-db-retire-parser]] cuts readers over; the dual-write keeps the
 * row honest with the mirror so callers reading either source see the same answer. Best-effort: a
 * missing specs row (pre-authored slug / pre-backfill) is a 0-row UPDATE, not an error.
 */
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

    // Phase 3 dual-write to public.specs — the future-canonical row. Map mirror-shape fields to typed
    // columns: status → specs.status, flags.deferred → specs.deferred (the trigger rolls status to
    // 'deferred' when set; un-setting restores the phase rollup), flags.critical → specs.priority,
    // flags.intended_status → specs.intended_status (cleared on disposition). The phase_states snapshot
    // remains spec_card_state-only — per-phase PR/merge_sha already dual-writes via
    // `applyMergedBuildEffects` ([[agent-jobs]]), so the typed `spec_phases` row stays canonical for
    // phase progress.
    //
    // spec-fold-from-db-row Phase 2 (expand step): the dual-write expanded to also cover the SURVIVING
    // spec_card_state.flags that newly carry typed homes on specs — short_circuit / short_circuit_reason
    // (director-dismiss-park-and-short-circuit-spec), vale_pass + ada_disposition (spec-review-agent),
    // merged_pr (the one-shot card-level shipping PR), and last_merge_sha (the deploy-aware UI slot).
    // Same best-effort + scoped contract: a 0-row UPDATE (no specs row yet) is silently fine.
    await dualWriteSpecRow(workspaceId, slug, patch);

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

/**
 * spec-authoring-writes-db-and-worker-materialize Phase 3 — dual-write helper. Map a spec_card_state
 * patch (status / flags subset / last_merge_sha) onto the typed `public.specs` columns so the future-
 * canonical row stays in sync with the mirror writes. Best-effort: a 0-row UPDATE (no specs row yet for
 * this slug — a pre-backfill / pre-author edge) is silently fine; the mirror is still the read-path until
 * [[../specs/spec-readers-from-db-retire-parser]] cuts readers over.
 *
 * Field mapping (spec-authoring-writes-db-and-worker-materialize Phase 3):
 *  - patch.status                  → specs.status (holds the EXPLICIT in_review / folded / deferred
 *                                    lifecycle overrides; phase progress is DERIVED at read time, not
 *                                    rolled into this column — the rollup trigger was dropped).
 *  - patch.flags.deferred          → specs.deferred (the readers project this to a 'deferred' status when
 *                                    set; un-setting restores the underlying phase rollup at read time).
 *  - patch.flags.critical          → specs.priority ('critical' / null — mirrors the markdown column
 *                                    shape).
 *  - patch.flags.intended_status   → specs.intended_status (cleared on Ada's disposition;
 *                                    'planned' / 'deferred' otherwise).
 *
 * spec-fold-from-db-row Phase 2 (expand step) — five more typed columns mirror the surviving flags:
 *  - patch.last_merge_sha          → specs.last_merge_sha   (the deploy-aware UI slot).
 *  - patch.flags.short_circuit         → specs.short_circuit         (boolean, paired with reason).
 *  - patch.flags.short_circuit_reason  → specs.short_circuit_reason  (text; cleared when short_circuit=false).
 *  - patch.flags.vale_pass         → specs.vale_pass         (Vale's CHECKLIST pass — TRANSIENT, consumed).
 *  - patch.flags.vale_review_passed → specs.vale_review_passed_at (build-gate-durable-review-signal — the
 *                                    DURABLE pass stamp; true → now(), false/undefined → null. NOT consumed
 *                                    by the disposition writers, so it survives the spec leaving in_review).
 *  - patch.flags.ada_disposition   → specs.ada_disposition   ('autonomous_same' | 'autonomous_downgrade' |
 *                                    'pending_upgrade'; cleared on dispose).
 *  - patch.flags.merged_pr         → specs.merged_pr         (one-shot card-level shipping PR — multi-
 *                                    phase specs use spec_phases.pr instead).
 *  - patch.flags.vale_disposition        → specs.vale_disposition        (vale-reasons-the-disposition
 *                                    Phase 1 — 'planned' / 'deferred'; cleared on send-back).
 *  - patch.flags.vale_disposition_reason → specs.vale_disposition_reason (Vale's plain-text WHY paired
 *                                    with vale_disposition).
 *
 * A flag key whose value is `undefined` in the incoming flags object is treated as a CLEAR (writes null
 * for nullable columns) — this matches the spec_card_state writers' convention of setting flags to
 * `undefined` to consume them (e.g. applyAdaDisposition clearing intended_status on dispose). A flag key
 * absent from the patch is left untouched on the specs row.
 */
async function dualWriteSpecRow(
  workspaceId: string,
  slug: string,
  patch: { status?: SpecStatus; flags?: SpecCardFlags; last_merge_sha?: string | null },
): Promise<void> {
  try {
    const updateFields: Record<string, unknown> = {};
    // specs-status-override-only: `specs.status` is an OVERRIDE-ONLY column. Only the EXPLICIT lifecycle
    // overrides (in_review / deferred / folded) may be PERSISTED; a DERIVED state (planned / in_progress /
    // shipped / rejected) must CLEAR the column to NULL so the readers compute status purely from the phase
    // rollup (`deriveSpecCardStatus`). A caller can carry a derived rollup in `patch.status` (e.g. the merge
    // effects / director spec-status action pass the phase rollup, the disposition lane passes `planned`) —
    // writing that derived value to the override column lies in the DB (the noop-pipeline-test-4 `planned`
    // bug). So we map a derived status to NULL here, at the single dual-write choke point every markSpecCard*
    // writer funnels through.
    if (patch.status !== undefined) {
      updateFields.status = isOverrideStatus(patch.status) ? patch.status : null;
    }
    if (patch.last_merge_sha !== undefined) updateFields.last_merge_sha = patch.last_merge_sha;
    if (patch.flags) {
      const f = patch.flags;
      if (Object.prototype.hasOwnProperty.call(f, "deferred")) {
        updateFields.deferred = !!f.deferred;
      }
      if (Object.prototype.hasOwnProperty.call(f, "critical")) {
        updateFields.priority = f.critical ? "critical" : null;
      }
      if (Object.prototype.hasOwnProperty.call(f, "intended_status")) {
        const v = f.intended_status;
        updateFields.intended_status = v === "planned" || v === "deferred" ? v : null;
      }
      // spec-fold-from-db-row Phase 2 (expand step) — five additional flag → typed-column mirrors.
      if (Object.prototype.hasOwnProperty.call(f, "short_circuit")) {
        updateFields.short_circuit = f.short_circuit === undefined ? null : !!f.short_circuit;
      }
      if (Object.prototype.hasOwnProperty.call(f, "short_circuit_reason")) {
        const v = f.short_circuit_reason;
        updateFields.short_circuit_reason = typeof v === "string" && v.length ? v : null;
      }
      if (Object.prototype.hasOwnProperty.call(f, "vale_pass")) {
        updateFields.vale_pass = f.vale_pass === undefined ? null : !!f.vale_pass;
      }
      // build-gate-durable-review-signal — the DURABLE review-passed timestamp. `true` stamps now(),
      // `false`/undefined clears it (a send-back / re-author must re-review). Only the Vale-pass writer and
      // the back-to-review writer carry this key; every other writer omits it, leaving the column untouched.
      if (Object.prototype.hasOwnProperty.call(f, "vale_review_passed")) {
        const stamp = new Date().toISOString();
        updateFields.vale_review_passed_at = f.vale_review_passed ? stamp : null;
      }
      if (Object.prototype.hasOwnProperty.call(f, "ada_disposition")) {
        const v = f.ada_disposition;
        updateFields.ada_disposition =
          v === "autonomous_same" || v === "autonomous_downgrade" || v === "pending_upgrade" ? v : null;
      }
      // vale-reasons-the-disposition Phase 1 — Vale's reasoned planned/deferred recommendation +
      // its plain-text WHY. Written by markSpecCardValePassed on a PASS; cleared alongside vale_pass on
      // a send-back (markSpecCardBackToReview). Ada's sweep will consume both in Phase 2.
      if (Object.prototype.hasOwnProperty.call(f, "vale_disposition")) {
        const v = f.vale_disposition;
        updateFields.vale_disposition = v === "planned" || v === "deferred" ? v : null;
      }
      if (Object.prototype.hasOwnProperty.call(f, "vale_disposition_reason")) {
        const v = f.vale_disposition_reason;
        updateFields.vale_disposition_reason = typeof v === "string" && v.length ? v : null;
      }
      if (Object.prototype.hasOwnProperty.call(f, "merged_pr")) {
        const v = f.merged_pr;
        updateFields.merged_pr = typeof v === "number" && Number.isFinite(v) ? v : null;
      }
    }
    if (!Object.keys(updateFields).length) return;
    updateFields.updated_at = new Date().toISOString();
    const admin = createAdminClient();
    await admin
      .from("specs")
      .update(updateFields)
      .eq("workspace_id", workspaceId)
      .eq("slug", slug);
  } catch {
    /* best-effort — the spec_card_state mirror already landed; the future-canonical row catches up on
       the next author/edit pass via [[specs-table]] upsertSpec (idempotent), or the backfill script. */
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
  opts: { status: SpecStatus; mergeSha: string | null; phaseStates?: SpecCardPhaseState[]; prNumber?: number | null },
): Promise<void> {
  const status = opts.phaseStates && opts.phaseStates.length ? rollupPhaseStatus(opts.phaseStates) : opts.status;
  const actor = `merge:${opts.mergeSha ?? ""}`;
  const phaseIndices = (opts.phaseStates ?? []).map((p) => p.index);
  const history: HistoryEntry[] = [
    { field: "status", actor, reason: "build merged on main" },
    ...phaseIndices.map((i) => ({ field: "phase" as const, phaseIndex: i, actor, reason: "build merged on main" })),
  ];
  // spec-status-phase-pr-provenance Phase 1: a **one-shot spec** (no `## Phase` sections) has no per-phase
  // slot to carry the shipping PR — so record it at the CARD level via `flags.merged_pr` (alongside
  // `last_merge_sha`). Multi-phase specs tag their phases directly in `phase_states[i].pr`, so the
  // card-level slot is set only when there are no phases.
  const cardFlags: SpecCardFlags = { deploy_pending: true };
  if (opts.prNumber && (!opts.phaseStates || opts.phaseStates.length === 0)) {
    cardFlags.merged_pr = opts.prNumber;
  }
  await upsertCardState(
    workspaceId,
    slug,
    {
      status,
      phase_states: opts.phaseStates,
      last_merge_sha: opts.mergeSha,
      flags: cardFlags,
    },
    history,
  );
}

/** Set/clear the `blocked` transient flag (spec-blockers — a spec gated behind an uncleared prerequisite). */
export async function markSpecCardBlocked(workspaceId: string, slug: string, blocked: boolean): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { blocked } });
}

/**
 * spec-review-agent Phase 3 — the spec-creation entry point. Sets the card to `in_review` (the build
 * pipeline refuses it until cleared) AND records the AUTHOR'S intended destination (`planned` or
 * `deferred`) on `flags.intended_status` — a SUGGESTION the director (Ada) uses for her disposition lane,
 * never binding. Idempotent: re-calling on an already-`in_review` row leaves the existing
 * `intended_status` intact when the caller passes the same value, and audits a status transition only on a
 * net change. Every NEWLY-authored spec-creation surface (planner, triage, fix-spec builders, director
 * split/author, Ada/coach) should call this immediately after committing the spec markdown.
 */
export async function markSpecCardForReview(
  workspaceId: string,
  slug: string,
  intendedStatus: "planned" | "deferred",
  audit: { actor: string; reason?: string },
): Promise<void> {
  await upsertCardState(
    workspaceId,
    slug,
    { status: "in_review", flags: { intended_status: intendedStatus } },
    [{ field: "status", actor: audit.actor, reason: audit.reason ?? `spec authored — intended_status=${intendedStatus}` }],
  );
}

/**
 * spec-review-agent Phase 3 — Vale's quality verdict (pass leg): record that she walked the CHECKLIST
 * and the spec is well-formed. Sets `flags.vale_pass=true` so Ada's disposition lane can pick it up.
 * Does NOT flip the status — a passed spec stays in `in_review` until Ada (or, on UPGRADE, the CEO)
 * disposes it. The bounce leg (`needs_fix`) doesn't touch this flag; it surfaces via `director_activity`.
 *
 * build-gate-durable-review-signal — ALSO stamps the DURABLE `vale_review_passed` marker (mirrors to
 * `specs.vale_review_passed_at`). UNLIKE `vale_pass` (consumed by Ada's disposition), this survives the spec
 * leaving in_review, so the claim-time build gate can still tell — at build time — that the spec passed
 * review. Cleared only by `markSpecCardBackToReview` (a send-back / re-author must re-review).
 *
 * vale-reasons-the-disposition Phase 1 — when the review pass ALSO carried a reasoned planned/deferred
 * recommendation (Vale hydrated once + emitted the disposition alongside quality — 'extra verdict
 * free'), persist it on `flags.vale_disposition` + `flags.vale_disposition_reason`. Ada's disposition
 * sweep will consume both in Phase 2 (replacing the trust-the-author stub). Absent on a legacy pass —
 * the sweep falls back to `intended_status`.
 */
export async function markSpecCardValePassed(
  workspaceId: string,
  slug: string,
  audit: { actor: string; reason?: string },
  disposition?: { disposition: "planned" | "deferred"; disposition_reason: string },
): Promise<void> {
  const flags: SpecCardFlags = { vale_pass: true, vale_review_passed: true };
  if (disposition) {
    flags.vale_disposition = disposition.disposition;
    flags.vale_disposition_reason = disposition.disposition_reason;
  }
  await upsertCardState(workspaceId, slug, { flags }, [
    { field: "status", actor: audit.actor, reason: audit.reason ?? "vale: pass (quality check cleared)" },
  ]);
  // bo-reactive-gated-build-enqueue Phase 2 — fire-and-forget the reactive build-eligibility event.
  // enqueueBuildIfDue re-checks the FULL gate (deferred/auto_build/blockers/in-flight), so firing on the
  // Vale pass alone is safe: if the spec still needs Ada's disposition the consumer no-ops for free, and
  // applyAdaDisposition('planned') re-fires when Ada dispositions it. Untyped client + swallowed reject
  // so a broken event pipe never breaks the review-pass write (the */5 platform-director cron is the
  // gated backstop). Same pattern as brain/index.refresh (roadmap-actions.ts:503).
  try {
    const { inngest } = await import("@/lib/inngest/client");
    await inngest
      .send({ name: "build/spec-build-eligible", data: { workspace_id: workspaceId, slug } })
      .catch(() => {});
  } catch {
    /* best-effort — the card write already landed; the cron backstop will catch it. */
  }
}

/**
 * vale-instant-per-spec-review — Vale's quality verdict (needs_fix leg): stamp the DURABLE
 * "reviewed → malformed" marker so the spec LEAVES Vale's queue until it's re-authored. Sets
 * `flags.vale_pass=false` (mirrors to `specs.vale_pass=false`), reusing the existing tri-state:
 *
 *   • `null`  — never verdicted → IN Vale's queue (`selectUnreviewedInReviewSpecs` picks it up).
 *   • `false` — reviewed, needs_fix → OUT of the queue (no re-review until the spec is re-authored).
 *   • `true`  — passed → OUT of the queue, parked for Ada's disposition lane.
 *
 * `markSpecCardBackToReview` NULLs `vale_pass` on every re-author / send-back, so a corrected spec
 * re-enters the queue naturally (the same content-change signal that already re-admits a passed spec).
 * WITHOUT this, a `needs_fix` spec kept `vale_pass=null` and stayed in the pool — tolerable under the
 * old 15-min batch cron, but the instant-per-spec poll (~30s) would re-review it every cycle, a Max-
 * session firehose on one malformed spec. Ada's disposition lane already treats `false` like `null`
 * (`spec-dispose.ts`: `if (!r.vale_pass) continue`), so a needs_fix spec is correctly NOT disposed.
 * Does NOT flip status — the spec stays `in_review` (the build hard-stop holds).
 */
export async function markSpecCardValeNeedsFix(
  workspaceId: string,
  slug: string,
  audit: { actor: string; reason?: string },
): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { vale_pass: false } }, [
    {
      field: "status",
      actor: audit.actor,
      reason: audit.reason ?? "vale: needs_fix (malformed — re-review on re-author)",
    },
  ]);
}

/**
 * spec-review-agent Phase 3 — Ada's disposition: flip a Vale-passed `in_review` spec to its final
 * column (`planned` or `deferred`) and CONSUME the disposition flags (clear `intended_status`,
 * `vale_pass`, `ada_disposition` so the same lane can't re-touch it). Records who/what on the audit
 * ledger. The `kind` records the asymmetric branch: same → autonomous_same, downgrade → autonomous_downgrade.
 * UPGRADE (gated) does NOT call this directly — it parks `flags.ada_disposition='pending_upgrade'` and
 * the CEO's pick resolves it (via the standard `markSpecCardStatus` / `markSpecCardDeferred` writers).
 */
export async function applyAdaDisposition(
  workspaceId: string,
  slug: string,
  decision: "planned" | "deferred",
  kind: "autonomous_same" | "autonomous_downgrade",
  audit: { actor: string; reason?: string },
): Promise<void> {
  // specs-status-override-only: the disposition flips the spec OUT of the `in_review` override into the
  // normal build flow. `planned` is a DERIVED state, NOT an override — so we must CLEAR `specs.status` to
  // NULL (the rollup then derives `planned` from the phases), NEVER persist a literal `'planned'` (the
  // noop-pipeline-test-4 bug: a stored derived state on the override-only column). `deferred` IS a true
  // override → store it. Either way we consume the lane flags + set flags.deferred so display + rollup agree;
  // un-deferring restores the underlying phase progress via flags.deferred=false.
  //
  // The override write goes straight to `specs.status` via setSpecStatus — NOT through the spec_card_state
  // `status` mirror, whose CHECK only allows planned/in_progress/shipped/rejected (it can hold neither
  // `deferred` nor NULL). We therefore omit `patch.status` here and let the flag write carry the lane state.
  const patch: { flags?: SpecCardFlags } = {
    flags: {
      intended_status: undefined,
      vale_pass: undefined,
      ada_disposition: undefined,
      deferred: decision === "deferred",
    },
  };
  await upsertCardState(workspaceId, slug, patch, [
    { field: "status", actor: audit.actor, reason: audit.reason ?? `ada: ${kind} → ${decision}` },
    { field: "deferred", actor: audit.actor, reason: audit.reason ?? `ada: ${kind} → ${decision}` },
  ]);
  // Clear the in_review override on the CANONICAL row: planned → NULL (purely derived), deferred → 'deferred'.
  try {
    const { setSpecStatus } = await import("@/lib/specs-table");
    await setSpecStatus(workspaceId, slug, decision === "deferred" ? "deferred" : null, audit.actor);
  } catch {
    /* best-effort — the flag write above already landed; the next reconcile/dispose pass backstops. */
  }
  // bo-reactive-gated-build-enqueue Phase 2 — Ada moving the spec into the buildable lane is the OTHER
  // build-eligibility transition. Fire only on `planned` (a `deferred` disposition parks the spec, the
  // gate would no-op anyway). The consumer runs `enqueueBuildIfDue` which re-checks the full gate;
  // firing on markSpecCardValePassed AND here is intentional — either transition alone may make the spec
  // eligible (Vale pass on an already-planned/queued dependent, or Ada disposing a pre-passed spec).
  if (decision === "planned") {
    try {
      const { inngest } = await import("@/lib/inngest/client");
      await inngest
        .send({ name: "build/spec-build-eligible", data: { workspace_id: workspaceId, slug } })
        .catch(() => {});
    } catch {
      /* best-effort — the disposition already landed; the cron backstop will catch it. */
    }
  }
}

/**
 * spec-review-agent Phase 3 — Ada parks an UPGRADE pending the CEO's approval (suggestion=`deferred`,
 * she wants `planned`). The spec stays in `in_review`; `flags.ada_disposition='pending_upgrade'`
 * dedupes the lane (the next sweep skips it). The CEO's pick resolves to either `applyAdaDisposition`
 * (build it now) or markSpecCardDeferred (park it).
 */
export async function markSpecCardPendingUpgrade(
  workspaceId: string,
  slug: string,
  audit: { actor: string; reason?: string },
): Promise<void> {
  await upsertCardState(workspaceId, slug, { flags: { ada_disposition: "pending_upgrade" } }, [
    { field: "status", actor: audit.actor, reason: audit.reason ?? "ada: parking UPGRADE for CEO approval" },
  ]);
}

/**
 * spec-review-agent Phase 4 — the SHARED back-to-review writer. Any agent that spots a malformed/off
 * spec (Vale on a re-check, Bo refusing to build on an empty/phaseless body, Ada's `spec-status` action,
 * repair/regression noticing an authored spec doesn't pass the CHECKLIST, the CEO via the board control)
 * flips the card back to `in_review` so it returns to Vale's queue — the build pipeline refuses to
 * dispatch an in_review spec, which is the whole point (don't build around a broken spec).
 *
 * Consumes the prior disposition lane's signals: `vale_pass`, `ada_disposition`, `intended_status` are
 * cleared so the next Vale pass + Ada dispose start from scratch (a re-author may genuinely change what
 * the author intended, and the prior Vale verdict is stale once the file changed). Idempotent: re-calling
 * on an already-in_review row leaves it in_review and re-audits.
 *
 * build-gate-durable-review-signal — ALSO clears the DURABLE `vale_review_passed` marker (→
 * `specs.vale_review_passed_at = null`). A send-back means the spec changed materially / failed re-check, so
 * the prior "passed review" stamp is stale: the spec must pass Vale AGAIN before the build gate releases it.
 *
 * Best-effort + audited via `spec_status_history`. The CALLER is responsible for recording the matching
 * `director_activity` row (`spec_sent_back_to_review`) with their actor — that side carries the diagnosis
 * the CEO reads (which check failed, who sent it back, what to fix).
 */
export async function markSpecCardBackToReview(
  workspaceId: string,
  slug: string,
  audit: { actor: string; reason?: string },
): Promise<void> {
  await upsertCardState(
    workspaceId,
    slug,
    {
      status: "in_review",
      flags: {
        vale_pass: undefined,
        vale_review_passed: false,
        ada_disposition: undefined,
        intended_status: undefined,
        deferred: false,
        // vale-reasons-the-disposition Phase 1 — clear the recommendation alongside vale_pass so a
        // materially-changed spec must be re-reviewed AND re-disposed (Ada's Phase-2 sweep won't reuse
        // the stale rec).
        vale_disposition: undefined,
        vale_disposition_reason: undefined,
      },
    },
    [
      { field: "status", actor: audit.actor, reason: audit.reason ?? "sent back to in_review (malformed/off — re-review needed)" },
    ],
  );
  // retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 2 — the reactive
  // `spec-review/spec-mutated` kick is retired (Vale's LLM lane is gone). A send-back that
  // discovers a defect in a shipped spec is handled downstream by the re-author path (which
  // re-runs the deterministic gate at [[spec-review-gate]]).
}

/**
 * director-dismiss-park-and-short-circuit-spec Phase 2: set/clear the **short-circuit** marker on a card.
 * Pairs with the status flip to `shipped` (which the caller writes via `markSpecCardStatus` in the same
 * action). The board reads `flags.short_circuit` + `flags.short_circuit_reason` to render the card as
 * "shipped + short-circuited" with the reason in a sub-line, distinguishing it from a fully-built card.
 *
 * `shortCircuit=true` requires `reason` (no silent short-circuits — enforced at the caller / the worker
 * helper). `shortCircuit=false` clears BOTH fields. Best-effort, audited via the standard history ledger
 * (the underlying status flip's row in `spec_status_history` records the transition; this writer adds no
 * extra history row, since `short_circuit` isn't in the CHECK-constrained `field` enum).
 */
export async function markSpecCardShortCircuit(
  workspaceId: string,
  slug: string,
  shortCircuit: boolean,
  reason?: string,
): Promise<void> {
  const flags: SpecCardFlags = shortCircuit
    ? { short_circuit: true, short_circuit_reason: (reason ?? "").slice(0, 1000) }
    : { short_circuit: false, short_circuit_reason: undefined };
  await upsertCardState(workspaceId, slug, { flags });
}
