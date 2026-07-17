/**
 * specs-table — the future-canonical read/write surface for `public.specs` + `public.spec_phases`
 * ([[../tables/specs]] · [[../tables/spec_phases]]), the DB-resident spec BODY (db-driven-specs M1,
 * [[../specs/spec-body-table-and-backfill]] Phase 2).
 *
 * Parallel to [[spec-card-state]] (status-only mirror) until [[../specs/spec-readers-from-db-retire-parser]]
 * cuts readers over to read FROM here instead of `docs/brain/specs/*.md`. This module ONLY adds the writer
 * + read surface — no caller has been retargeted yet. Backfill ([[../recipes/backfill-specs-from-markdown]])
 * fills the rows.
 *
 * Key invariants:
 *  - Spec status is DERIVED from `spec_phases` by the READERS ([[brain-roadmap]] `rollupPhaseStatus` /
 *    `deriveStatus`), not by a DB trigger — the `spec_phases_rollup` trigger was dropped
 *    (derive-rollup-status P3). The stored `specs.status` column is kept only for the EXPLICIT lifecycle
 *    overrides `in_review` / `deferred` / `folded` (not derivable); any stale rollup value it still carries
 *    is ignored by the deriving readers, which always prefer the phase rollup.
 *  - `spec_phases.id` is STABLE across moves — `movePhase(phaseId, newSpecId, newPosition)` is a SINGLE
 *    UPDATE that preserves the id + pr + merge_sha + created_at, so a phase's PR provenance chain
 *    ([[../specs/spec-status-phase-pr-provenance]]) survives a lift between specs.
 *  - `upsertSpec` replaces a spec's `spec_phases` by `(spec_id, position)` — phases at the same
 *    position retain their stable id (and pr/merge_sha unless explicitly overridden). New positions
 *    INSERT, vanished positions DELETE.
 *  - `upsertSpec` is SELF-GATING (harden-spec-submission): before any write it asserts that every phase
 *    ends up with a non-empty `verification` (the load-bearing field `renderSpecRow` turns into the
 *    `### Verification` markdown Vale reviews + Vera tests) and the spec has a non-empty `why` + `what`,
 *    using EFFECTIVE values (the value the caller passes, or the already-stored value on a preserve-update).
 *    This turns "author through [[author-spec]]" from a CONVENTION into a runtime chokepoint: a RAW
 *    `upsertSpec(...)` from a session/script that skips the [[author-spec]] gates now THROWS
 *    `UngatedSpecAuthorError` instead of silently landing an untestable, intent-less spec (the class that
 *    produced the 2026-07 needs_fix batch). The gates in [[author-spec]] still run first (nicer errors +
 *    brain-refs + parent resolution) — this is the belt-and-suspenders floor that no path can skip.
 *
 * Service-role only (RLS allows read for authenticated; ALL ops for service_role). All callers go
 * through `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { Phase } from "@/lib/brain-roadmap";

export type { Phase } from "@/lib/brain-roadmap";

/**
 * Thrown by `upsertSpec` when a spec would land with an empty per-phase `verification` or an empty
 * spec-level `why` / `what` (harden-spec-submission). Loud + specific (slug + the offending fields) so a
 * caller that skipped the [[author-spec]] chokepoint fails at the write instead of silently persisting an
 * un-buildable / unreadable spec. Fix: author through `authorSpecRowStructured` / `submitSpec` (the
 * [[submit-spec]] skill), never raw `upsertSpec`.
 */
export class UngatedSpecAuthorError extends Error {
  constructor(slug: string, problems: string[]) {
    super(
      `upsertSpec refused to write spec \`${slug}\`: ${problems.join("; ")}. ` +
        `Every phase needs a non-empty verification (>=1 observable acceptance check — agents test it), and ` +
        `the spec needs why + what (the human-readable intent on the spec detail page). Author through ` +
        `\`authorSpecRowStructured\` / \`submitSpec\` (the submit-spec ` +
        `skill) — never raw \`upsertSpec\` — so the Verification + Intent gates run.`,
    );
    this.name = "UngatedSpecAuthorError";
  }
}

/** The full enum the `specs.status` column accepts (CHECK-constrained in migration). */
export type SpecStatus = "in_review" | "planned" | "in_progress" | "shipped" | "deferred" | "folded";

export interface SpecPhaseRow {
  id: string;
  spec_id: string;
  position: number;
  title: string;
  body: string;
  status: Phase;
  pr: number | null;
  merge_sha: string | null;
  /** spec-goal-branch-pm-flow M2 — the `claude/build-{slug}` spec-branch commit SHA where this phase BUILT
   *  (stampPhaseBuilt). Set when the phase builds on the branch; distinct from `merge_sha` (the M5
   *  main-promotion stamp). A phase with `build_sha` set but `status !== 'shipped'` is built-on-branch. */
  build_sha: string | null;
  verification: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this phase exists. Paired with `what`.
   *  HARD gate at the app-layer chokepoint (`author-spec.assertEveryNodeHasIntent`). NULL only for rows
   *  authored BEFORE the intent columns landed. */
  why: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this phase ships. Paired
   *  with `why`. HARD gate at the app-layer chokepoint. NULL only for pre-intent rows. */
  what: string | null;
  /** fixes-as-phases — 'phase' (normal) | 'fix' (appended by the pre-merge-fix flow for a spec-test
   *  regression; builds one-at-a-time on a resumed session, then the origin self-re-tests). */
  kind: string;
  /** fixes-as-phases — for kind='fix' phases, the spec_test check_key(s) this fix addresses. */
  origin_check_keys: string[];
  /** marco-logistics-director-seat Phase 1 — per-phase jsonb side-channel bag for structured,
   *  non-provenance phase state (e.g. a decision recorded by an investigation-only phase whose
   *  downstream siblings gate on it). Written by [[setPhaseMetadata]]; read via getSpec/listSpecs
   *  (flowed through the RPCs by `to_jsonb(p)`). Distinct from build_sha/pr/merge_sha (provenance)
   *  and body/verification/why/what (authored content). Defaults to `{}` at the DB layer. */
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SpecRow {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by: string[];
  priority: string | null;
  deferred: boolean;
  intended_status: "planned" | "deferred" | null;
  /** specs-status-override-only: OVERRIDE-ONLY column. `null` = no override → status is PURELY DERIVED from
   *  the phase rollup ([[brain-roadmap]] `deriveSpecCardStatus`). A non-null value is an explicit lifecycle
   *  override: in_review / deferred / folded (never a derived planned/in_progress/shipped). */
  status: SpecStatus | null;
  intended_status_set_by: string | null;
  repair_signature: string | null;
  /** spec-authoring-writes-db-and-worker-materialize Phase 1 — when set, the spec is a regression-agent-
   *  authored fix for this slug (mirrors the `**Regression-of:** [[<slug>]]` header line). */
  regression_of_slug: string | null;
  /** spec-authoring-writes-db-and-worker-materialize Phase 1 — the regression-agent's signature for this
   *  fix (mirrors the `**Regression-signature:** `<sig>`` header line). Same-signature recurrences converge
   *  on one spec, sibling to repair_signature. */
  regression_signature: string | null;
  /** no-spec-parent — origin-spec slug this fix-spec RELATES to (a link, never a parent). A self-healing
   *  agent (repair / db-health / …) sets this instead of an `extends [[../specs/…]]` parent. */
  related_spec: string | null;
  auto_build: boolean;
  /** spec-review-agent Phase 3 — Vale's CHECKLIST verdict; `true` once she's passed the spec. The In
   *  Review board lane reads this to render Vale's pending vs Vale-passed state per card. */
  vale_pass: boolean | null;
  /** build-gate-durable-review-signal — the DURABLE "passed Vale review" stamp. Set alongside `vale_pass`
   *  on a Vale PASS; UNLIKE `vale_pass` it is NOT consumed by Ada's disposition, so it survives the spec
   *  leaving in_review. The claim-time build gate reads THIS (non-null = passed review) instead of the
   *  consumed `vale_pass`. Cleared on a send-back / re-author (must be re-reviewed). */
  vale_review_passed_at: string | null;
  /** spec-review-agent Phase 3 — Ada's disposition state. `pending_upgrade` means a CEO Planned/Deferred
   *  call is parked waiting; null means Ada hasn't touched this Vale-passed spec yet. */
  ada_disposition: "autonomous_same" | "autonomous_downgrade" | "pending_upgrade" | null;
  /** vale-reasons-the-disposition Phase 1 — Vale's reasoned planned/deferred recommendation on a PASS.
   *  Populated by the spec-review lane when the pass carries a disposition; NULL for a needs_fix verdict
   *  or a pass authored BEFORE this column existed (Ada's Phase-2 sweep falls back to `intended_status`).
   *  Cleared alongside `vale_pass` on send-back / re-author. */
  vale_disposition: "planned" | "deferred" | null;
  /** vale-reasons-the-disposition Phase 1 — the plain-text WHY paired with `vale_disposition`. Ada's
   *  asymmetric routing surfaces this on the CEO Approval Request (UPGRADE) / notification (DOWNGRADE). */
  vale_disposition_reason: string | null;
  milestone_id: string | null;
  /** spec-status-phase-pr-provenance Phase 1 — card-level shipping PR for a ONE-SHOT spec (zero phases):
   *  the single merge that ships the whole spec, recorded here because there's no phase slot to carry it.
   *  For multi-phase specs the per-phase `spec_phases.pr` is the provenance; this stays null. */
  merged_pr: number | null;
  /** spec-status-phase-pr-provenance Phase 1 — the merge SHA paired with `merged_pr` (one-shot specs).
   *  Also the deploy-aware UI slot the board compares against `VERCEL_GIT_COMMIT_SHA`. */
  last_merge_sha: string | null;
  /** spec-goal-branch-pm-flow M4 — the `goal/{goal-slug}` merge commit SHA where this spec's
   *  `claude/build-{slug}` branch was merged onto its goal branch ([[stampSpecGoalBranchSha]]). The durable
   *  "on the goal branch" marker: the claim-time blocked_by gate clears a GOAL-MATE blocker when this is set
   *  (a goal-mate never ships to main until M5's atomic goal promotion), and M5 reads "every spec in the goal
   *  has goal_branch_sha" to detect goal-complete. Null = not yet on the goal branch. */
  goal_branch_sha: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this spec exists. Paired with `what`.
   *  HARD gate at the app-layer chokepoint (`author-spec.assertEveryNodeHasIntent`). NULL only for rows
   *  authored BEFORE the intent columns landed. Not markdown — the plain-language lint (no code fences /
   *  no `file:line`) rejects jargon that belongs in the technical body. */
  why: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this spec ships. Paired
   *  with `why`. HARD gate at the app-layer chokepoint. Distinct from `summary`. */
  what: string | null;
  /** pm-structured-intent-and-refs Phase 2 — typed parent kind (`function`/`mandate`/`milestone`), or
   *  NULL for legacy rows. Paired with `parent_ref`. The free-text `parent` stays for display; the
   *  typed pair is authoritative for CI resolution. */
  parent_kind: "function" | "mandate" | "milestone" | null;
  /** pm-structured-intent-and-refs Phase 2 — the resolvable value for the typed parent (function slug,
   *  mandate key, or milestone id). Paired with `parent_kind`. */
  parent_ref: string | null;
  /** every-spec-writer-authors-machine-runnable-verifications Phase 2 — OPTIONAL, non-blocking
   *  founder-facing advisory note ("after ship, open /dashboard/x and confirm the layout reads
   *  right"). NULL is the norm (a spec ships without one). NEVER read by the fold gate / promote
   *  gate / deterministic spec-check runner — machine-runnable `spec_phase_checks` are the sole
   *  ship gate. Rendered on the spec card + post-ship founder surface. */
  human_review: string | null;
  created_at: string;
  updated_at: string;
  phases: SpecPhaseRow[];
}

/** Field set callers can pass to `upsertSpec` for the parent `specs` row. Defaults applied at DB level. */
export interface SpecRowInput {
  slug: string;
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by: string[];
  priority: string | null;
  deferred: boolean;
  intended_status: "planned" | "deferred" | null;
  /** Optional explicit status. The readers DERIVE a different planned/in_progress/shipped value once phases
   *  land — that's the whole point of the read-time rollup (no DB trigger maintains this column; the rollup
   *  trigger was dropped). This stored value carries only the explicit lifecycle overrides
   *  (in_review/deferred/folded). Omit to default to `in_review`. */
  status?: SpecStatus;
  intended_status_set_by?: string | null;
  repair_signature?: string | null;
  /** When set, mirrors the regression-agent header `**Regression-of:** [[<slug>]]` (the regressed spec slug). */
  regression_of_slug?: string | null;
  /** When set, mirrors the regression-agent header `**Regression-signature:** `<sig>``. */
  regression_signature?: string | null;
  /** no-spec-parent — origin-spec slug this fix-spec RELATES to (a link, never a parent). Set by a
   *  self-healing agent instead of an `extends [[../specs/…]]` parent. PASS `null` to CLEAR; OMIT to preserve. */
  related_spec?: string | null;
  auto_build?: boolean;
  milestone_id?: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this spec exists. HARD gated at the
   *  app-layer chokepoint; this SDK writer simply persists. PASS `null` to CLEAR; OMIT to PRESERVE. */
  why?: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this spec ships. HARD
   *  gated at the app-layer chokepoint; this SDK writer simply persists. */
  what?: string | null;
  /** pm-structured-intent-and-refs Phase 2 — typed parent kind. */
  parent_kind?: "function" | "mandate" | "milestone" | null;
  /** pm-structured-intent-and-refs Phase 2 — the resolvable typed-parent value. */
  parent_ref?: string | null;
  /** every-spec-writer-authors-machine-runnable-verifications Phase 2 — optional, non-blocking
   *  founder-facing advisory note. PASS `null` to CLEAR; OMIT to PRESERVE. Never gated on — a spec
   *  with a human_review note whose machine checks are green still auto-folds/promotes/ships. */
  human_review?: string | null;
}

/** Field set callers pass per-phase. `pr`/`merge_sha`/`verification` are optional — preserved when omitted. */
export interface SpecPhaseInput {
  position: number;
  title: string;
  body: string;
  status: Phase;
  /** PASS `null` to CLEAR. OMIT (undefined) to PRESERVE an existing value on update. */
  pr?: number | null;
  merge_sha?: string | null;
  verification?: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this phase exists. HARD gated at the
   *  app-layer chokepoint. PASS `null` to CLEAR; OMIT to PRESERVE. */
  why?: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this phase ships. */
  what?: string | null;
  /** fixes-as-phases — defaults to 'phase' on insert; set 'fix' for an appended fix phase. */
  kind?: string;
  origin_check_keys?: string[];
}

export interface UpsertSpecResult {
  spec_id: string;
  /** position (1-indexed) → phase id, for callers that want to chain phase-keyed writes. */
  phase_ids: Record<number, string>;
}

export interface ListSpecsFilter {
  status?: SpecStatus;
  owner?: string;
  /** Pass `null` to filter to standalone specs (no milestone link), a uuid to filter to one milestone, or
   *  omit to ignore. */
  milestone_id?: string | null;
  /** list-specs-with-phases-rpc — server-side scope filter passed to the `list_specs_with_phases` RPC.
   *  `'active'` = boardable specs (`status IS NULL OR status <> 'folded'`); `'archived'` = folded specs;
   *  `'all'` = every spec. Defaults to `'all'` so pre-RPC listSpecs semantics (folded-inclusive) are
   *  preserved for the callers that need them (director-kpis, spec-dispose audits). Boardable readers
   *  should prefer the [[getActiveSpecs]] wrapper. */
  scope?: "active" | "archived" | "all";
}

interface SpecRowDb {
  id: string;
  workspace_id: string;
  slug: string;
  title: string;
  summary: string | null;
  owner: string;
  parent: string;
  blocked_by: string[] | null;
  priority: string | null;
  deferred: boolean;
  intended_status: "planned" | "deferred" | null;
  status: SpecStatus;
  intended_status_set_by: string | null;
  repair_signature: string | null;
  regression_of_slug: string | null;
  regression_signature: string | null;
  related_spec: string | null;
  auto_build: boolean;
  vale_pass: boolean | null;
  vale_review_passed_at: string | null;
  ada_disposition: "autonomous_same" | "autonomous_downgrade" | "pending_upgrade" | null;
  vale_disposition: "planned" | "deferred" | null;
  vale_disposition_reason: string | null;
  milestone_id: string | null;
  merged_pr: number | null;
  last_merge_sha: string | null;
  goal_branch_sha: string | null;
  why: string | null;
  what: string | null;
  parent_kind: "function" | "mandate" | "milestone" | null;
  parent_ref: string | null;
  /** every-spec-writer-authors-machine-runnable-verifications Phase 2 — optional advisory founder note. */
  human_review: string | null;
  created_at: string;
  updated_at: string;
}

const SPEC_COLUMNS =
  "id, workspace_id, slug, title, summary, owner, parent, blocked_by, priority, deferred, intended_status, status, intended_status_set_by, repair_signature, regression_of_slug, regression_signature, related_spec, auto_build, vale_pass, vale_review_passed_at, ada_disposition, vale_disposition, vale_disposition_reason, milestone_id, merged_pr, last_merge_sha, goal_branch_sha, why, what, parent_kind, parent_ref, human_review, created_at, updated_at";
const PHASE_COLUMNS =
  "id, spec_id, position, title, body, status, pr, merge_sha, build_sha, verification, why, what, kind, origin_check_keys, created_at, updated_at";

/**
 * Phase lifecycle status is 100% DERIVED from provenance — NEVER trusted from the stored `status` column.
 * The build pipeline used to STAMP `status` ('in_progress' at build-start + build-commit), which drifts (a
 * resume-no-edits that never re-stamps, a missed hook) and desyncs the roadmap from the real pipeline. Per
 * the "nothing stamps a lifecycle status" invariant, the stored `spec_phases.status` is OVERRIDE-ONLY: only
 * `rejected` (a cut phase) and a deliberate fold-now/short-circuit `shipped` close survive; every other
 * value is re-derived here from `build_sha` / `pr` / `merge_sha` at read time. The visual "in progress"
 * (a build is running before any build_sha lands) is a SPEC-level, live-build-job-driven overlay in
 * [[brain-roadmap]] — not a phase concern.
 */
export function derivePhaseStatus(row: {
  status?: string | null;
  build_sha?: string | null;
  pr?: number | null;
  merge_sha?: string | null;
}): Phase {
  if (row.status === "rejected") return "rejected"; // explicit cut — a real override
  if ((row.merge_sha ?? null) !== null || (row.pr ?? null) !== null) return "shipped"; // promoted to main
  if (row.status === "shipped") return "shipped"; // deliberate fold-now / short-circuit close (no provenance)
  if ((row.build_sha ?? null) !== null) return "in_progress"; // built on the branch, not yet shipped
  return "planned"; // nothing built yet
}

/**
 * spec-read-eff-board-context — the pure DB-row → SpecRow mapper the pooled getSpec / listSpecs
 * paths use to reconstruct a `SpecRow` from raw `to_jsonb(s)` + `to_jsonb(p)` payloads returned by
 * the server-side RPCs (get_spec_with_phases / list_specs_with_phases / get_spec_board_context).
 * Exported so the get_spec_board_context caller (brain-roadmap.getSpec) can reuse the SAME mapper
 * on the RPC's `boardable_specs` array — otherwise a per-column re-map would drift the moment a
 * new `public.specs` column lands and one caller forgot to update. Pure; no I/O.
 */
export function specRowFromDbForPool(db: unknown, phases: unknown[]): SpecRow {
  return specRowFromDb(db as SpecRowDb, phases as SpecPhaseRow[]);
}

function specRowFromDb(db: SpecRowDb, phases: SpecPhaseRow[]): SpecRow {
  // Derive every phase's lifecycle status from provenance at the SDK read boundary, so EVERY consumer of
  // getSpec/listSpecs (board, gates, chained-phase picker) sees the derived status — never the stamped one.
  phases = phases.map((p) => ({ ...p, status: derivePhaseStatus(p) }));
  return {
    id: db.id,
    workspace_id: db.workspace_id,
    slug: db.slug,
    title: db.title,
    summary: db.summary,
    owner: db.owner,
    parent: db.parent,
    blocked_by: db.blocked_by ?? [],
    priority: db.priority,
    deferred: db.deferred,
    intended_status: db.intended_status,
    status: db.status,
    intended_status_set_by: db.intended_status_set_by,
    repair_signature: db.repair_signature,
    regression_of_slug: db.regression_of_slug,
    regression_signature: db.regression_signature,
    related_spec: db.related_spec,
    auto_build: db.auto_build,
    vale_pass: db.vale_pass,
    vale_review_passed_at: db.vale_review_passed_at,
    ada_disposition: db.ada_disposition,
    vale_disposition: db.vale_disposition,
    vale_disposition_reason: db.vale_disposition_reason,
    milestone_id: db.milestone_id,
    merged_pr: db.merged_pr,
    last_merge_sha: db.last_merge_sha,
    goal_branch_sha: db.goal_branch_sha,
    why: db.why,
    what: db.what,
    parent_kind: db.parent_kind,
    parent_ref: db.parent_ref,
    // every-spec-writer-authors-machine-runnable-verifications Phase 2 — advisory founder note; NULL is the norm.
    human_review: db.human_review ?? null,
    created_at: db.created_at,
    updated_at: db.updated_at,
    phases,
  };
}

/**
 * db-reduce-calls-q-1756037457588317045 — very-short-TTL in-process cache for `getSpec` reads.
 *
 * The `public.get_spec_with_phases(uuid, text)` RPC was the top DB-time query by call volume in the
 * box's `pg_stat_statements` sample (215k calls, 0ms mean, 31s total). Per-call cost is already fine
 * (index scan on `specs_ws_slug`) — the win is FEWER calls. Many code paths call `getSpec(ws, slug)`
 * two-or-three times within one request (`queueRoadmapBuild` reads the row twice; every
 * `brain-roadmap.getSpec` wraps the same underlying read; the box worker's tick handlers re-read the
 * same spec inside a burst of nearby jobs). This module-level cache collapses those tight-window
 * duplicates without lengthening the freshness window meaningfully.
 *
 * Design invariants:
 *  - **TTL bounds staleness at any path this SDK cannot see** (a raw SQL migration, an admin script
 *    outside this module). All in-module writers below invalidate proactively; the TTL is the belt.
 *  - **Every writer in this file calls `invalidateSpecCache(ws, slug)` on success.** The read-after-
 *    write pattern in `author-spec.ts` (`getSpec` → `upsertSpec` → `getSpec` to verify persistence)
 *    stays correct because `upsertSpec`'s invalidation forces the second read to hit the RPC.
 *  - **Null results are cached** so a nonexistent slug in a tight retry loop doesn't hammer the RPC
 *    either. Null entries invalidate the same way — a write for that (ws, slug) evicts the null.
 *  - **`clearSpecCacheForTests()` is exported** so tests that share process state can reset.
 *
 * db-load-getspec-cache — raised from 2_000 to 15_000 so the cache survives the box's 5_000ms poll
 * tick (scripts/builder-worker.ts `POLL_MS`) — the 2s TTL only collapsed within-burst duplicates
 * and re-fired the RPC every tick. Writers still invalidate proactively via `invalidateSpecCache`,
 * so 15s is only an upper bound on staleness for out-of-module writes (raw SQL / admin scripts).
 */
const SPEC_CACHE_TTL_MS = 15_000;

type SpecCacheEntry = { row: SpecRow | null; expiresAt: number };
const specCache = new Map<string, SpecCacheEntry>();

function specCacheKey(workspaceId: string, slug: string): string {
  return `${workspaceId}::${slug}`;
}

function readSpecCache(workspaceId: string, slug: string): { hit: true; row: SpecRow | null } | { hit: false } {
  const key = specCacheKey(workspaceId, slug);
  const entry = specCache.get(key);
  if (!entry) return { hit: false };
  if (Date.now() >= entry.expiresAt) {
    specCache.delete(key);
    return { hit: false };
  }
  return { hit: true, row: entry.row };
}

function writeSpecCache(workspaceId: string, slug: string, row: SpecRow | null): void {
  specCache.set(specCacheKey(workspaceId, slug), { row, expiresAt: Date.now() + SPEC_CACHE_TTL_MS });
}

// db-load-getspec-cache — listener API so a downstream wrapper cache (brain-roadmap.getSpec) can
// evict its (workspaceId, slug) entry in lockstep with the inner cache. Every writer path in this
// file already calls `invalidateSpecCache`, so subscribing here means the wrapper cache stays
// consistent without duplicating the writer list.
type SpecCacheInvalidator = (workspaceId: string, slug: string) => void;
const specCacheInvalidators = new Set<SpecCacheInvalidator>();

export function onSpecCacheInvalidate(cb: SpecCacheInvalidator): () => void {
  specCacheInvalidators.add(cb);
  return () => specCacheInvalidators.delete(cb);
}

/** Evict a cached (workspace, slug) entry. Called by every writer in this module on success. */
export function invalidateSpecCache(workspaceId: string, slug: string): void {
  specCache.delete(specCacheKey(workspaceId, slug));
  for (const cb of specCacheInvalidators) {
    try {
      cb(workspaceId, slug);
    } catch {
      // Best-effort — a listener error must never wedge a mutator path.
    }
  }
}

/** Test-only cache reset. Never called by production code paths. */
export function clearSpecCacheForTests(): void {
  specCache.clear();
}

/**
 * One spec by (workspace, slug) — the parent `specs` row joined with its `spec_phases` ordered by position.
 * Returns `null` when no row matches. Read by authenticated users (RLS) — the admin client just bypasses RLS.
 *
 * cut-internal-egress-pooler-and-spec-rpcs Phase 2 — sourced from the `get_spec_with_phases(uuid, text)`
 * RPC (supabase/migrations/20261004120000_get_spec_with_phases_rpc.sql). The RPC does the specs+phases
 * join SERVER-SIDE and returns one `(spec jsonb, phases jsonb)` row, replacing the pre-Phase-2 two
 * PostgREST round trips (`.from('specs')` then `.from('spec_phases')`) — the same set_config preamble +
 * auth churn `list_specs_with_phases` already retired for [[listSpecs]]. On the box the pooled path
 * (Phase-1 pg-pool → single pooled query) is preferred; anywhere the pool is unavailable falls back
 * to the supabase-js RPC path. Returned SpecRow shape is byte-identical to the pre-Phase-2 path.
 *
 * db-reduce-calls-q-1756037457588317045 — a 2-second module-level cache (see the block above) collapses
 * tight-window duplicate reads for the same (ws, slug). Every writer in this module invalidates its
 * slug, so a read-after-write on the same request sees fresh data.
 */
export async function getSpec(workspaceId: string, slug: string): Promise<SpecRow | null> {
  const cached = readSpecCache(workspaceId, slug);
  if (cached.hit) return cached.row;
  // Pooled path (box worker + any runtime with pooler creds): one round trip, no PostgREST preamble.
  // `undefined` = pool unavailable / query error → fall through to supabase-js; `null` = no such slug.
  try {
    const { getSpecWithPhases } = await import("@/lib/pg-pool");
    const pooled = await getSpecWithPhases<SpecRowDb, SpecPhaseRow>(workspaceId, slug);
    if (pooled === null) {
      writeSpecCache(workspaceId, slug, null);
      return null;
    }
    if (pooled !== undefined) {
      const row = specRowFromDb(pooled.spec, pooled.phases);
      writeSpecCache(workspaceId, slug, row);
      return row;
    }
  } catch {
    /* fall through to supabase-js RPC */
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_spec_with_phases", {
    p_workspace_id: workspaceId,
    p_slug: slug,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{ spec: SpecRowDb; phases: SpecPhaseRow[] | null }>;
  const row = rows[0];
  if (!row || !row.spec) {
    writeSpecCache(workspaceId, slug, null);
    return null;
  }
  const result = specRowFromDb(row.spec, (row.phases ?? []) as SpecPhaseRow[]);
  writeSpecCache(workspaceId, slug, result);
  return result;
}

/**
 * Every spec in a workspace, optionally filtered — sourced from the `list_specs_with_phases(uuid, text)`
 * RPC (supabase/migrations/20261001120000_list_specs_with_phases_rpc.sql). The RPC does the specs+phases
 * join SERVER-SIDE and streams `(spec jsonb, phases jsonb)` rows back, so no id array crosses the wire —
 * retiring the interim `.in("spec_id", [ids])` batching that PR #1429 + #1430 landed to work around the
 * ~16KB undici header cap (UND_ERR_HEADERS_OVERFLOW) once the workspace held a few hundred specs.
 *
 * `filter.scope` picks the server-side row set (`'active'` | `'archived'` | `'all'` — default `'all'` to
 * preserve pre-RPC folded-inclusive semantics); the remaining `status` / `owner` / `milestone_id`
 * filters are applied in-memory after the RPC returns and are cheap on the bounded result set. Sorted
 * client-side by slug for a stable, deterministic order.
 */
export async function listSpecs(workspaceId: string, filter: ListSpecsFilter = {}): Promise<SpecRow[]> {
  const scope = filter.scope ?? "all";
  // spec-read-eff-pool — Phase 2 of docs/brain/specs/spec-read-efficiency-for-scaling-fleet.md.
  // Pooled path (box worker + any runtime with pooler creds): one pooled query, no PostgREST
  // preamble. `null` = pool unavailable / query error → fall through to the supabase-js RPC path
  // (same fail-open contract as `getSpec` above).
  let rows: Array<{ spec: SpecRowDb; phases: SpecPhaseRow[] | null }> | null = null;
  try {
    const { listSpecsWithPhases } = await import("@/lib/pg-pool");
    const pooled = await listSpecsWithPhases<SpecRowDb, SpecPhaseRow>(workspaceId, scope);
    if (pooled !== null) {
      rows = pooled.map((r) => ({ spec: r.spec, phases: r.phases }));
    }
  } catch {
    /* fall through to supabase-js RPC */
  }
  if (rows === null) {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("list_specs_with_phases", {
      p_workspace_id: workspaceId,
      p_scope: scope,
    });
    if (error) throw error;
    rows = (data ?? []) as Array<{ spec: SpecRowDb; phases: SpecPhaseRow[] | null }>;
  }
  let out = rows.map((r) => specRowFromDb(r.spec, (r.phases ?? []) as SpecPhaseRow[]));
  if (filter.status) out = out.filter((r) => r.status === filter.status);
  if (filter.owner) out = out.filter((r) => r.owner === filter.owner);
  if (filter.milestone_id !== undefined) {
    const wanted = filter.milestone_id;
    out = wanted === null
      ? out.filter((r) => r.milestone_id === null)
      : out.filter((r) => r.milestone_id === wanted);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Every BOARDABLE spec — thin wrapper over [[listSpecs]] with `scope='active'`, i.e. `status IS NULL OR
 *  status <> 'folded'` filtered server-side by the `list_specs_with_phases` RPC. Prefer this over
 *  `listSpecs` on the board / pipeline / claim-gate readers that never want folded rows across the wire. */
export async function getActiveSpecs(workspaceId: string): Promise<SpecRow[]> {
  return listSpecs(workspaceId, { scope: "active" });
}

/** Every spec in a workspace, folded rows included — thin wrapper over [[listSpecs]] with `scope='all'`.
 *  Same folded-inclusive set the pre-RPC `listSpecs()` returned; use this on readers that need the full
 *  set (director-kpis owner attribution, spec-dispose audits, drift). */
export async function getAllSpecs(workspaceId: string): Promise<SpecRow[]> {
  return listSpecs(workspaceId, { scope: "all" });
}

/**
 * UPSERT the parent `specs` row + REPLACE its `spec_phases` by (spec_id, position):
 *   - matching positions are UPDATED in place (preserving id + pr/merge_sha unless explicitly overridden)
 *   - new positions are INSERTED (with optional pr/merge_sha if supplied)
 *   - vanished positions are DELETED
 * Spec status is DERIVED from the resulting phase set by the readers (`rollupPhaseStatus`), not written
 * here — there is no `spec_phases_rollup` trigger anymore. This writer only persists structure; the
 * explicit `in_review`/`folded`/`deferred` lifecycle states come from their own writers (`upsertSpec`,
 * fold, deferred toggle).
 *
 * Not atomic across the parent + child writes (supabase-js has no transaction surface). Re-running the
 * same `upsertSpec` is idempotent (the read-modify-write of phases by position is deterministic).
 */
/**
 * harden-spec-submission — the runtime gate. Reject an author write whose EFFECTIVE per-phase
 * `verification`, or the spec's `why`/`what`, is empty. Effective = the value the caller passes, or (when
 * the field is OMITTED on a preserve-update) the value already stored — so a narrow, status-only re-author
 * of an already-gated spec still passes, while a fresh or content-changing write with empty
 * verification/intent THROWS. Runs BEFORE any DB write so nothing partial lands.
 *
 * Scope is deliberate: `verification` is the load-bearing per-phase field (agents test it), and `why`/`what`
 * are the human-readable spec intent Dylan requires to understand a spec on the detail page. Per-phase
 * `why`/`what` is NOT required here — the markdown author path leaves phase intent NULL and enforcing it
 * would halt those lanes; per-phase intent stays a structured-path nicety. Fix phases (`appendFixPhases`)
 * never route through upsertSpec, so they're untouched.
 */
/** The stored fields the guard reads through to on a preserve-update. */
export interface ExistingSpecForGate {
  why?: string | null;
  what?: string | null;
}
export interface ExistingPhaseForGate {
  verification: string | null;
  why: string | null;
  what: string | null;
}

/**
 * PURE decision half of the runtime gate (harden-spec-submission) — no DB. Given the write payload plus the
 * already-stored spec/phase values, return the list of authoring problems (empty when the write is fully
 * authored). Effective value = provided, or the stored value when the field is OMITTED (undefined) on a
 * preserve-update; an explicit `null` is treated as clearing → a problem. Exported so it can be unit-tested
 * without a Supabase client.
 */
export function computeUpsertAuthoringProblems(
  row: Pick<SpecRowInput, "why" | "what">,
  phases: Pick<SpecPhaseInput, "position" | "title" | "verification" | "why" | "what">[],
  existingSpec: ExistingSpecForGate | null,
  existingByPos: Map<number, ExistingPhaseForGate>,
): string[] {
  const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  const eff = <T>(provided: T | undefined, existing: T | undefined): T | undefined =>
    provided !== undefined ? provided : existing;
  const problems: string[] = [];
  // Spec-level intent — enforced by BOTH author paths already (markdown throws MissingIntentError on a
  // missing `**Why:**`/`**What:**`; structured runs `assertEveryNodeHasIntent`). Requiring it here is
  // redundant for the sanctioned paths and only bites a raw bypass.
  if (!nonEmpty(eff(row.why, existingSpec?.why ?? undefined))) problems.push("spec `why` (plain-language intent) is empty");
  if (!nonEmpty(eff(row.what, existingSpec?.what ?? undefined))) problems.push("spec `what` (plain-language intent) is empty");
  if (!phases.length) problems.push("spec has no phases (nothing to build or test)");
  for (const p of phases) {
    const prev = existingByPos.get(p.position);
    const label = `phase ${p.position}${p.title ? ` (${p.title})` : ""}`;
    // Per-phase VERIFICATION is the one load-bearing per-phase field: `renderSpecRow` synthesizes the
    // `### Verification` markdown FROM this column, and that render is exactly what Vale reviews + Vera
    // spec-tests. An empty column → no `### Verification` in the render → Vale bounces it needs_fix and Vera
    // has 0 checks. This is the 2026-07 needs_fix class. Redundant with `assertEveryPhaseHasVerification`
    // on both author paths; only bites a raw bypass.
    //
    // We DELIBERATELY do NOT require per-phase `why`/`what` here: the markdown author path
    // (`authorSpecRowFromMarkdown`, ~11 box-worker lanes) legitimately leaves phase intent NULL (it only
    // carries spec-level intent), so enforcing it would halt those lanes. Per-phase intent stays a
    // structured-path concern (`assertEveryNodeHasIntent`), not a floor invariant.
    if (!nonEmpty(eff(p.verification, prev?.verification ?? undefined))) problems.push(`${label} has no verification`);
  }
  return problems;
}

async function assertUpsertFullyAuthored(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  row: SpecRowInput,
  phases: SpecPhaseInput[],
): Promise<void> {
  // Resolve the existing spec + its phases so a preserve-update (omitted field) reads through to the stored
  // value instead of being seen as empty.
  const { data: existingSpec } = await admin
    .from("specs")
    .select("id, why, what")
    .eq("workspace_id", workspaceId)
    .eq("slug", row.slug)
    .maybeSingle();
  const existingByPos = new Map<number, ExistingPhaseForGate>();
  if ((existingSpec as { id?: string } | null)?.id) {
    const { data: exPhases } = await admin
      .from("spec_phases")
      .select("position, verification, why, what")
      .eq("spec_id", (existingSpec as { id: string }).id);
    for (const p of (exPhases ?? []) as Array<{ position: number } & ExistingPhaseForGate>) {
      existingByPos.set(p.position, { verification: p.verification, why: p.why, what: p.what });
    }
  }
  const problems = computeUpsertAuthoringProblems(
    row,
    phases,
    existingSpec as ExistingSpecForGate | null,
    existingByPos,
  );
  if (problems.length) throw new UngatedSpecAuthorError(row.slug, problems);
}

export async function upsertSpec(
  workspaceId: string,
  row: SpecRowInput,
  phases: SpecPhaseInput[],
): Promise<UpsertSpecResult> {
  const admin = createAdminClient();
  // harden-spec-submission — self-gating floor. Throws `UngatedSpecAuthorError` before any write if a phase
  // would land with empty verification/why/what (or the spec with empty why/what). The [[author-spec]]
  // chokepoint already asserts this and passes complete data, so this is a no-op for the sanctioned path and
  // a hard stop for a raw bypass.
  await assertUpsertFullyAuthored(admin, workspaceId, row, phases);
  const upsertRow: Record<string, unknown> = {
    workspace_id: workspaceId,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    owner: row.owner,
    parent: row.parent,
    blocked_by: row.blocked_by,
    priority: row.priority,
    deferred: row.deferred,
    intended_status: row.intended_status,
    intended_status_set_by: row.intended_status_set_by ?? null,
    repair_signature: row.repair_signature ?? null,
    regression_of_slug: row.regression_of_slug ?? null,
    regression_signature: row.regression_signature ?? null,
    // no-spec-parent — persist the origin-spec LINK (never a parent). Omitted → PRESERVE (undefined skips).
    ...(row.related_spec !== undefined ? { related_spec: row.related_spec } : {}),
    auto_build: row.auto_build ?? false,
    milestone_id: row.milestone_id ?? null,
    updated_at: new Date().toISOString(),
  };
  // pm-structured-intent-and-refs Phase 1 — persist the plain-language intent columns. `undefined` means
  // "preserve" (the caller isn't touching them); an explicit `null` or a string is written through.
  if (row.why !== undefined) upsertRow.why = row.why;
  if (row.what !== undefined) upsertRow.what = row.what;
  // pm-structured-intent-and-refs Phase 2 — persist the typed parent pair (function|mandate|milestone).
  // Same preserve-on-undefined rule.
  if (row.parent_kind !== undefined) upsertRow.parent_kind = row.parent_kind;
  if (row.parent_ref !== undefined) upsertRow.parent_ref = row.parent_ref;
  // every-spec-writer-authors-machine-runnable-verifications Phase 2 — persist the OPTIONAL, non-blocking
  // founder-facing advisory note. Same preserve-on-undefined rule: PASS `null` to CLEAR; OMIT (undefined)
  // to PRESERVE on a re-author. NEVER read by the fold gate / promote gate / spec-check runner (see
  // `computeUpsertAuthoringProblems` — it is deliberately NOT listed in the problem check).
  if (row.human_review !== undefined) upsertRow.human_review = row.human_review;
  // specs-status-override-only: `specs.status` is OVERRIDE-ONLY (deferred / folded — the two NON-DERIVABLE
  // lifecycle states). When a caller passes an explicit status, persist it ONLY if it's a true override; a
  // DERIVED value (planned / in_progress / shipped) OR `in_review` (now derived from the phase rollup +
  // `vale_review_passed_at` — specs-status-overrides-only migration) is normalized to NULL so the readers
  // derive it (never a leaked stored derived state — the noop-pipeline-test-4 bug). Omitting status entirely
  // keeps the DB default (NULL) for a brand-new spec, which — with no phases and a null `vale_review_passed_at`
  // — DERIVES `in_review` so the build pipeline still holds a freshly-authored spec.
  if (row.status !== undefined) {
    const isOverride = row.status === "deferred" || row.status === "folded";
    upsertRow.status = isOverride ? row.status : null;
  }

  // folded-spec-must-stay-folded: `folded` is TERMINAL. A re-author must NEVER silently clear that override
  // back to NULL/active — that is the db-reduce-calls split (archive.d/ markdown present, but a later
  // re-author normalized a derived status to NULL → the rollup re-DERIVES `planned`/`in_progress` → the
  // archived spec re-appears on the active board AND `cancelJobsForArchivedSpecs` auto-cancels its builds
  // as "spec archived"). Read the existing override; if it's already `folded`, PRESERVE it unless the caller
  // is EXPLICITLY re-folding (`row.status === 'folded'`). The only sanctioned un-fold is an explicit
  // `setSpecStatus(slug, null)` by the CEO — a re-author is never an implicit un-fold. (Belt-and-suspenders:
  // an omitted `status` is already preserved by the upsert, but a derived `status` would clobber it; this
  // re-asserts `folded` in both cases.)
  {
    const { data: existing } = await admin
      .from("specs")
      .select("status")
      .eq("workspace_id", workspaceId)
      .eq("slug", row.slug)
      .maybeSingle();
    if ((existing as { status: string | null } | null)?.status === "folded" && upsertRow.status !== "folded") {
      upsertRow.status = "folded";
    }
  }

  const { data: upserted, error: upErr } = await admin
    .from("specs")
    .upsert(upsertRow, { onConflict: "workspace_id,slug" })
    .select("id")
    .single();
  if (upErr || !upserted) throw upErr ?? new Error("upsert specs returned no row");
  const specId = (upserted as { id: string }).id;

  const { data: existingPhases, error: exErr } = await admin
    .from("spec_phases")
    .select("id, position, pr, merge_sha")
    .eq("spec_id", specId);
  if (exErr) throw exErr;
  const byPosition = new Map<number, { id: string; pr: number | null; merge_sha: string | null }>();
  for (const p of (existingPhases ?? []) as { id: string; position: number; pr: number | null; merge_sha: string | null }[]) {
    byPosition.set(p.position, { id: p.id, pr: p.pr, merge_sha: p.merge_sha });
  }

  const inputPositions = new Set(phases.map((p) => p.position));
  const positionsToDelete: number[] = [];
  for (const pos of byPosition.keys()) if (!inputPositions.has(pos)) positionsToDelete.push(pos);
  if (positionsToDelete.length) {
    const { error: dErr } = await admin
      .from("spec_phases")
      .delete()
      .eq("spec_id", specId)
      .in("position", positionsToDelete);
    if (dErr) throw dErr;
  }

  const phaseIds: Record<number, string> = {};
  for (const phase of phases) {
    const existing = byPosition.get(phase.position);
    if (existing) {
      const updateRow: Record<string, unknown> = {
        title: phase.title,
        body: phase.body,
        status: phase.status,
        updated_at: new Date().toISOString(),
      };
      if (phase.pr !== undefined) updateRow.pr = phase.pr;
      if (phase.merge_sha !== undefined) updateRow.merge_sha = phase.merge_sha;
      if (phase.verification !== undefined) updateRow.verification = phase.verification;
      if (phase.why !== undefined) updateRow.why = phase.why;
      if (phase.what !== undefined) updateRow.what = phase.what;
      if (phase.kind !== undefined) updateRow.kind = phase.kind;
      if (phase.origin_check_keys !== undefined) updateRow.origin_check_keys = phase.origin_check_keys;
      const { error: uErr } = await admin.from("spec_phases").update(updateRow).eq("id", existing.id);
      if (uErr) throw uErr;
      phaseIds[phase.position] = existing.id;
    } else {
      const insertRow: Record<string, unknown> = {
        spec_id: specId,
        position: phase.position,
        title: phase.title,
        body: phase.body,
        status: phase.status,
        pr: phase.pr ?? null,
        merge_sha: phase.merge_sha ?? null,
        verification: phase.verification ?? null,
        why: phase.why ?? null,
        what: phase.what ?? null,
        kind: phase.kind ?? "phase",
        origin_check_keys: phase.origin_check_keys ?? [],
      };
      const { data: inserted, error: iErr } = await admin
        .from("spec_phases")
        .insert(insertRow)
        .select("id")
        .single();
      if (iErr || !inserted) throw iErr ?? new Error("insert spec_phases returned no row");
      phaseIds[phase.position] = (inserted as { id: string }).id;
    }
  }

  invalidateSpecCache(workspaceId, row.slug);
  return { spec_id: specId, phase_ids: phaseIds };
}

/**
 * Lift one phase between specs (or to a new slot in the same spec) preserving its stable `id`, `pr`,
 * `merge_sha`, `created_at` — the [[../specs/spec-status-phase-pr-provenance]] provenance chain.
 *
 * Single UPDATE moving the phase's `spec_id`/`position`. Both the old and new spec's board status are
 * DERIVED at read time from their phase sets (no DB trigger maintains `specs.status` — the rollup trigger was
 * dropped), so the move needs no status write. The unique `(spec_id, position)` index may reject the move if
 * the destination slot is already occupied; the caller is responsible for shifting positions first when so.
 */
export async function movePhase(
  phaseId: string,
  newSpecId: string,
  newPosition: number,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("spec_phases")
    .update({ spec_id: newSpecId, position: newPosition, updated_at: new Date().toISOString() })
    .eq("id", phaseId);
  if (error) throw error;
  // db-reduce-calls: the phase left one spec and joined another; both parents' cached SpecRows are now
  // stale. The move signature is keyed by phaseId (not slug), so the safe move is to bound staleness on
  // the TTL rather than resolve the two slugs with extra queries. movePhase is a low-volume primitive.
}

/**
 * Stamp a phase `shipped` with its PR provenance — the [[../specs/director-trust-phase-pr-provenance]] /
 * [[../specs/spec-status-phase-pr-provenance]] chain. Records the `merge_sha` (and `pr` when a PR was
 * opened) of the commit that shipped this phase. The readers DERIVE the parent `specs.status` from the
 * phases at read time (`deriveSpecCardStatus`/`rollupPhaseStatus` — there is no longer a DB trigger; the
 * rollup trigger was dropped in 20260725160000_drop_rollup_triggers_and_milestone_status.sql), so stamping
 * a leaf phase is the ONLY write needed to advance a spec — never set `specs.status` directly (db-driven-
 * specs: status is inferred from children, never manually set).
 */
export async function stampPhaseShipped(
  workspaceId: string,
  slug: string,
  position: number,
  provenance: { merge_sha: string | null; pr?: number | null },
): Promise<void> {
  const admin = createAdminClient();
  const { data: spec, error: sErr } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!spec) throw new Error(`stampPhaseShipped: no spec '${slug}' in workspace ${workspaceId}`);
  const { error } = await admin
    .from("spec_phases")
    .update({
      status: "shipped",
      merge_sha: provenance.merge_sha,
      pr: provenance.pr ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("spec_id", (spec as { id: string }).id)
    .eq("position", position);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
  // spec-timecard-chokepoint-instrumentation Phase 1 — one phase_shipped per ship. Placed at the top of
  // the canonical leaf write (auto-promotion, one-shot merge webhook, and goal atomic promotion all
  // route here), so a single insert covers every path without instrumenting each caller. Best-effort —
  // recordTimecardEvent swallows insert errors so a timecard blip never blocks the ship.
  try {
    const { recordTimecardEvent } = await import("./spec-timecards");
    await recordTimecardEvent(admin, {
      workspace_id: workspaceId,
      spec_slug: slug,
      phase_index: position,
      event_kind: "phase_shipped",
      actor: "worker",
      metadata: {
        merge_sha: provenance.merge_sha,
        ...(provenance.pr != null ? { pr: provenance.pr } : {}),
      },
    });
  } catch (e) {
    console.warn(`[timecards] phase_shipped emit failed spec=${slug} pos=${position}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Stamp a phase's BRANCH-BUILD provenance — spec-goal-branch-pm-flow M2. Records the `build_sha` (the
 * `claude/build-{slug}` spec-branch commit where this phase was built) WITHOUT shipping it. This is the
 * branch-flow counterpart to `stampPhaseShipped`: M1 made phases accumulate on a persistent spec branch
 * (one commit per phase, no per-phase main merge), so "built on the branch" is now an earlier, distinct
 * state from "shipped to main".
 *
 * Sets `build_sha` and moves the phase to `in_progress` (built — NOT shipped). It NEVER writes
 * `status='shipped'` or `merge_sha`: those stay reserved for the main-promotion stamp (M5 flips a
 * build_sha'd phase to shipped when the spec/goal branch lands on main). A no-op-on-shipped guard keeps it
 * from regressing a phase that already promoted (M5 ran first / a re-dispatch raced) — never overwrite a
 * `shipped`/`rejected` phase. The `build_sha` itself is always refreshed to the latest spec-branch commit
 * (a re-build of the same phase advances the tip), so the chaining trigger reads the current "built" SHA.
 *
 * No raw PM SQL — this is the only writer for `spec_phases.build_sha` (the pm-db-agent-toolkit invariant /
 * `_check-pm-sdk-compliance` guard). The post-2026-07-25 readers derive status purely (the rollup triggers
 * are gone), so this leaf write is inert to status derivation beyond the `in_progress` it sets.
 */
export async function stampPhaseBuilt(
  workspaceId: string,
  slug: string,
  position: number,
  provenance: { build_sha: string | null },
): Promise<void> {
  const admin = createAdminClient();
  const { data: spec, error: sErr } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!spec) throw new Error(`stampPhaseBuilt: no spec '${slug}' in workspace ${workspaceId}`);
  const specId = (spec as { id: string }).id;
  // Read the current phase status so we never regress a promoted phase back to in_progress. A phase that's
  // already shipped/rejected keeps its terminal status — we don't even refresh build_sha there (it's done).
  const { data: phase, error: pErr } = await admin
    .from("spec_phases")
    .select("status")
    .eq("spec_id", specId)
    .eq("position", position)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!phase) return; // no such phase (one-shot/single-phase spec with a mismatched position) — no-op
  const status = (phase as { status: string }).status;
  if (status === "shipped" || status === "rejected") return; // terminal — never regress
  const { error } = await admin
    .from("spec_phases")
    .update({
      // NOTHING-STAMPS-LIFECYCLE-STATUS: we write ONLY the build_sha provenance. The phase's lifecycle
      // status ('in_progress' once a build_sha exists) is DERIVED on read (`derivePhaseStatus`), never
      // stored — so a resume-no-edits or a missed hook can no longer leave the status out of sync with the
      // provenance. build_sha alone is the "built on the branch" signal.
      build_sha: provenance.build_sha,
      updated_at: new Date().toISOString(),
    })
    .eq("spec_id", specId)
    .eq("position", position);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * marco-logistics-director-seat Phase 1 — MERGE-write the phase's jsonb `metadata` bag. This is the
 * per-phase, structured, non-provenance side-channel: a decision recorded by an investigation-only
 * phase whose downstream siblings gate on it (e.g. Phase 1 of marco-logistics-director-seat stamps
 * `{ marco_landing: 'A' | 'B' }` here; Phase 3 keys on it). Distinct from build_sha/pr/merge_sha
 * (provenance) and body/verification/why/what (authored content).
 *
 * Semantics: JSONB-MERGE (`||`), not replace — the caller passes only the keys they want to write
 * and existing keys survive. That keeps two independent decisions on the same phase (from different
 * lanes) from clobbering each other. Pass an empty object to no-op.
 *
 * Idempotent (a second identical call writes the same merged shape) + safe to re-run. No lifecycle-
 * status side effects: metadata is inert to `derivePhaseStatus`.
 */
export async function setPhaseMetadata(
  workspaceId: string,
  slug: string,
  position: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  const { data: spec, error: sErr } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!spec) throw new Error(`setPhaseMetadata: no spec '${slug}' in workspace ${workspaceId}`);
  const specId = (spec as { id: string }).id;
  const { data: phase, error: pErr } = await admin
    .from("spec_phases")
    .select("id, metadata")
    .eq("spec_id", specId)
    .eq("position", position)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!phase) throw new Error(`setPhaseMetadata: no spec_phases row at position=${position} for '${slug}'`);
  const existing = ((phase as { metadata: Record<string, unknown> | null }).metadata ?? {}) as Record<string, unknown>;
  const merged = { ...existing, ...patch };
  const { error } = await admin
    .from("spec_phases")
    .update({ metadata: merged, updated_at: new Date().toISOString() })
    .eq("id", (phase as { id: string }).id);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * spec-goal-branch-pm-flow M2/M3 — "is this spec FULLY accumulated on its `claude/build-{slug}` branch?"
 *
 * Under M1's branch-accumulation model a spec's phases build one-by-one onto ONE persistent branch (no
 * per-phase main merge). A phase is "built on the branch" when it carries a `build_sha` ([[stampPhaseBuilt]])
 * OR is already terminal (shipped / rejected). A phase still `planned` — or `in_progress` WITHOUT a
 * `build_sha` (queued/building, not yet committed) — is NOT yet accumulated.
 *
 * Returns `{ complete, reason }`:
 *  - 0–1 phases ⇒ trivially complete (a one-shot/single-phase spec ships in one PR — nothing to accumulate).
 *  - every phase built-or-terminal ⇒ complete.
 *  - any un-built phase remains ⇒ NOT complete (with the offending positions in `reason`).
 *
 * Fails OPEN on a read error / missing spec row (returns complete:true) — a transient PM-read blip must
 * never wedge a legitimately-complete one-off spec, and the downstream tests/build gates still guard any
 * actual promotion.
 *
 * This is the M3 trigger gate (enqueue the pre-merge spec-test only once the WHOLE spec is on the branch),
 * the M4/M2 auto-merge accumulation gate, AND one of the three [[isSpecPromoteEligible]] inputs — all three
 * read the SAME predicate so they can never disagree on "is the spec fully built on its branch?".
 */
export async function isSpecAccumulationComplete(
  workspaceId: string | null,
  slug: string | null,
): Promise<{ complete: boolean; reason: string }> {
  if (!workspaceId || !slug) return { complete: true, reason: "no spec context — fail open" };
  try {
    const spec = await getSpec(workspaceId, slug);
    if (!spec) return { complete: true, reason: "no spec row — fail open (one-off/untracked)" };
    const phases = spec.phases ?? [];
    // 0–1 phases = one-shot / single-phase spec — it ships in one PR; nothing to accumulate.
    if (phases.length <= 1) return { complete: true, reason: `${phases.length} phase(s) — trivially complete` };
    // A phase is "built on the branch" if it carries a build_sha OR is already terminal (shipped/rejected).
    // Any phase still `planned` (or in_progress WITHOUT a build_sha — queued/building, not yet committed) is
    // un-accumulated → not complete.
    const unbuilt = phases.filter((p) => {
      if (p.status === "shipped" || p.status === "rejected") return false; // terminal — done
      return !p.build_sha; // not built on the branch yet
    });
    if (unbuilt.length === 0) {
      return { complete: true, reason: `all ${phases.length} phases built on branch` };
    }
    const positions = unbuilt.map((p) => p.position).join(",");
    return { complete: false, reason: `${unbuilt.length}/${phases.length} phase(s) not yet built on branch (positions ${positions})` };
  } catch (e) {
    // Fail OPEN — a PM-read blip must not wedge a complete one-off spec; the tests/build gates still apply.
    return { complete: true, reason: `accumulation read failed — fail open: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * derive-rollup-status: mark the LEAF phase being built `in_progress` at BUILD START. Now that a spec's
 * board status is the phase rollup (never a stored card-status read), a build that's underway must move a
 * PHASE — not the card — to in_progress, or the spec would read `planned` until its first phase ships. Flips
 * the earliest `planned` phase (the next one to build) to `in_progress`; the readers then DERIVE the card
 * status as `in_progress` from that phase at read time (no DB trigger maintains `specs.status` — the rollup
 * trigger was dropped in 20260725160000_drop_rollup_triggers_and_milestone_status.sql).
 *
 * Idempotent + safe: a no-op if a phase is already `in_progress` (a build is already signaled) or there's no
 * `planned` phase left (every phase shipped/rejected, or a one-shot spec with no phases — there the
 * builder's own status write handles in_progress). Never regresses a `shipped`/`rejected` phase. Returns the
 * position it flipped, or null when it made no change. Best-effort at the call site — a failure must never
 * break the build start.
 */
export async function markPhaseInProgress(_workspaceId: string, _slug: string): Promise<number | null> {
  // NO-OP (nothing-stamps-lifecycle-status). This used to stamp the next planned phase `in_progress` at
  // BUILD START so the card read in_progress before a build_sha existed. That stored lifecycle status is now
  // DERIVED — the roadmap shows "in progress" from a LIVE BUILD JOB (the `hasLiveBuild` overlay in
  // [[brain-roadmap]]) the instant a build is claimed, with ZERO DB write, so it's genuinely real-time.
  // Kept as a no-op so existing callers (roadmap/status route, platform-director, builder-worker) are
  // unchanged; it never mutates a phase's status again.
  return null;
}

/**
 * derive-rollup-status: flip every non-shipped, non-rejected phase of a spec to `shipped` on the CANONICAL
 * `spec_phases` table — the deliberate "close the rest" write the director's fold-now / short-circuit lane
 * needs. Now that the board status DERIVES from `spec_phases`, a fold-now that only touched the
 * `spec_card_state` mirror would leave the canonical phases planned and the derived card would read
 * `in_progress` instead of `shipped`. This moves the source of truth so the rollup lands on `shipped`.
 * No merge provenance is stamped (a fold-now isn't a merge — there's no PR/SHA); `merge_sha`/`pr` are left
 * untouched. Returns the positions it flipped. Idempotent: an already-all-shipped spec flips nothing.
 */
export async function markRemainingPhasesShipped(workspaceId: string, slug: string): Promise<number[]> {
  const admin = createAdminClient();
  const { data: spec, error: sErr } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!spec) return [];
  const specId = (spec as { id: string }).id;
  const { data: phases, error: pErr } = await admin
    .from("spec_phases")
    .select("position, status")
    .eq("spec_id", specId)
    .order("position", { ascending: true });
  if (pErr) throw pErr;
  const toFlip = ((phases ?? []) as { position: number; status: Phase }[])
    .filter((p) => p.status === "planned" || p.status === "in_progress")
    .map((p) => p.position);
  if (!toFlip.length) return [];
  const { error } = await admin
    .from("spec_phases")
    .update({ status: "shipped", updated_at: new Date().toISOString() })
    .eq("spec_id", specId)
    .in("position", toFlip);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
  return toFlip;
}

/**
 * derive-rollup-status: re-stamp a spec's phases on the CANONICAL `spec_phases` table — the audit's
 * deterministic verdict writer (the request-audit lane that grounds each phase against `spec_status_history`
 * + the merge subjects, regressing an "✅ ungrounded" phase to `planned`). Pre-derive the audit re-stamped
 * the `spec_card_state` mirror; now the board derives from `spec_phases`, so the verdict must land HERE for
 * the rollup to reflect it. Each entry is keyed by 1-based `position` and writes `{status, pr, merge_sha}`
 * (PR/SHA null clears). The readers DERIVE `specs.status` from the new phase states at read time (no DB
 * trigger maintains it — the rollup trigger was dropped in
 * 20260725160000_drop_rollup_triggers_and_milestone_status.sql). Positions absent from the input are left
 * untouched. Best-effort upstream — never the source-of-truth for in-flight phase work.
 */
export async function restampPhases(
  workspaceId: string,
  slug: string,
  phases: { position: number; status: Phase; pr: number | null; merge_sha: string | null }[],
): Promise<void> {
  if (!phases.length) return;
  const admin = createAdminClient();
  const { data: spec, error: sErr } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!spec) return;
  const specId = (spec as { id: string }).id;
  for (const p of phases) {
    const { error } = await admin
      .from("spec_phases")
      .update({ status: p.status, pr: p.pr, merge_sha: p.merge_sha, updated_at: new Date().toISOString() })
      .eq("spec_id", specId)
      .eq("position", p.position);
    if (error) throw error;
  }
  invalidateSpecCache(workspaceId, slug);
}

/**
 * fixes-as-phases — APPEND `kind='fix'` phases to an existing spec (INSERT-ONLY: never reads/updates/deletes
 * existing phases, so it can't clobber the origin's P1-P5 the way `upsertSpec` replace-by-position would).
 * New phases land after the current max position, `status:'planned'`, no `build_sha`. That does two things
 * for free (no explicit status write — `specs.status` stays override-only NULL):
 *   1. `isSpecAccumulationComplete` → false → `applyInTestingOverlay` returns the base rollup → the spec
 *      derives OUT of `in_testing` back to `in_progress` (a spec-test regression re-opens the spec).
 *   2. `queueNextChainedPhase` then picks the first planned (fix) phase, resumes the origin's Claude session
 *      on the same `claude/build-{slug}` branch, and builds it one-at-a-time; when the last fix ships the
 *      origin SELF-re-tests (`enqueueSpecTestIfDue` via `applyMergedBuildEffects`).
 * This is what retires the separate `fix-<slug>` spec model (no new spec row, no cold P1-P5 re-hydration,
 * no fix-<slug> chain to depth-guard). Returns the appended 1-based positions.
 */
export async function appendFixPhases(
  workspaceId: string,
  slug: string,
  fixes: { title: string; body: string; verification: string; origin_check_keys: string[] }[],
): Promise<{ appended: number; positions: number[] }> {
  if (!fixes.length) return { appended: 0, positions: [] };
  const admin = createAdminClient();
  const { data: spec, error: sErr } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!spec) return { appended: 0, positions: [] };
  const specId = (spec as { id: string }).id;
  const { data: maxRow } = await admin
    .from("spec_phases")
    .select("position")
    .eq("spec_id", specId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  let pos = (maxRow as { position: number } | null)?.position ?? 0;
  const positions: number[] = [];
  // verification-checks-source-of-truth — populate the typed `spec_phase_checks` rows for each appended fix
  // phase too, so a fix phase is a first-class structured object (the display + renderer read the rows, not
  // just the `verification` text column). Dynamic import avoids any import cycle (matches author-spec).
  const { upsertPhaseChecks, parseVerificationBlobToChecks } = await import("@/lib/spec-phase-checks-table");
  for (const f of fixes) {
    pos += 1;
    const { data: inserted, error } = await admin
      .from("spec_phases")
      .insert({
        spec_id: specId,
        position: pos,
        title: f.title,
        body: f.body,
        status: "planned" as Phase,
        verification: f.verification,
        kind: "fix",
        origin_check_keys: f.origin_check_keys,
      })
      .select("id")
      .single();
    if (error || !inserted) throw error ?? new Error("insert fix phase returned no row");
    positions.push(pos);
    // Best-effort: derive the typed checks from the fix phase's verification blob. Never fail the fix append
    // on a checks write (the column remains the fallback render source).
    try {
      const checks = parseVerificationBlobToChecks(f.verification);
      if (checks.length) await upsertPhaseChecks((inserted as { id: string }).id, checks);
    } catch (e) {
      console.warn(`[appendFixPhases] checks write failed for ${slug} phase ${pos}: ${(e as Error).message}`);
    }
  }
  invalidateSpecCache(workspaceId, slug);
  return { appended: positions.length, positions };
}

/** fixes-as-phases — count a spec's existing `kind='fix'` phases (used to number the next "Fix N" phase). */
export async function countFixPhases(workspaceId: string, slug: string): Promise<number> {
  const admin = createAdminClient();
  const { data: spec } = await admin
    .from("specs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .maybeSingle();
  if (!spec) return 0;
  const { count } = await admin
    .from("spec_phases")
    .select("id", { count: "exact", head: true })
    .eq("spec_id", (spec as { id: string }).id)
    .eq("kind", "fix");
  return count ?? 0;
}

/**
 * spec-test-request-fix-inline-author-and-approve Phase 2 — resolve the regression fix spec for an origin
 * by the typed linkage (`specs.regression_of_slug = originSlug`), not a hand-typed/deterministic slug.
 *
 * The inline spec-test card uses this so a renamed fix slug still surfaces — the linkage column is the
 * source of truth (set by the request-fix authoring path + the regression-agent's `**Regression-of:**`
 * header). Returns the most-recently-created fix when more than one row carries the same linkage (rare,
 * but possible across deterministic-slug regenerations). Phases are joined like `getSpec`.
 */
export async function getFixSpecForOrigin(
  workspaceId: string,
  originSlug: string,
): Promise<SpecRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("specs")
    .select(SPEC_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("regression_of_slug", originSlug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const specDb = data as SpecRowDb;
  const { data: phases, error: pErr } = await admin
    .from("spec_phases")
    .select(PHASE_COLUMNS)
    .eq("spec_id", specDb.id)
    .order("position", { ascending: true });
  if (pErr) throw pErr;
  return specRowFromDb(specDb, (phases ?? []) as SpecPhaseRow[]);
}

/** One phase by its stable id — the join-free read for provenance / phase-move tooling. */
export async function getPhase(phaseId: string): Promise<SpecPhaseRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_phases")
    .select(PHASE_COLUMNS)
    .eq("id", phaseId)
    .maybeSingle();
  if (error) throw error;
  return (data as SpecPhaseRow) ?? null;
}

/** Every spec linked to a milestone (`specs.milestone_id = milestoneId`), phases included. */
export async function specsForMilestone(workspaceId: string, milestoneId: string): Promise<SpecRow[]> {
  return listSpecs(workspaceId, { milestone_id: milestoneId });
}

/**
 * Write the EXPLICIT lifecycle override on `specs.status` — the two states NOT derivable from the phase
 * rollup: `deferred` (parked) and `folded` (archived after a fold). Mirrors goals-table `setGoalStatus`: a
 * slug-resolved single UPDATE with an `actor` tag bumped onto `updated_at` (the audit-grade trail lives
 * elsewhere — director_activity rows).
 *
 * specs-status-override-only: `specs.status` is OVERRIDE-ONLY. Pass `null` to CLEAR the override so the
 * status is PURELY DERIVED (the readers' `deriveSpecCardStatus`: the phase rollup, plus `in_review` derived
 * from rollup===planned + `vale_review_passed_at IS NULL`) — this is the sanctioned way to flip a spec OUT
 * of an override without leaking a derived value into the stored column (the noop-pipeline-test-4 bug).
 * Passing a DERIVED value (planned/in_progress/shipped) OR `in_review` (now derived — specs-status-overrides-
 * only migration) is normalized to NULL here with a warning so the override-only invariant can never be
 * broken by a stray caller. NOTE: to actually SEND a spec back to review, NULL `vale_review_passed_at` via
 * `markSpecCardBackToReview` — a status write alone no longer expresses "in review".
 *
 * This is the ONLY sanctioned `specs.status` writer outside `upsertSpec`. The deriving readers prefer the
 * phase rollup; this column carries the non-derivable overrides only (CLAUDE.md "Database is the spec":
 * derived status from the phase rollup, stored status columns are explicit lifecycle overrides).
 */
export async function setSpecStatus(
  workspaceId: string,
  slug: string,
  status: SpecStatus | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actor: string,
): Promise<void> {
  // Override-only guard: a derived destination (including the now-derived `in_review`) clears to NULL.
  let stored: SpecStatus | null = status;
  if (status !== null && !(status === "deferred" || status === "folded")) {
    console.warn(`[specs-table.setSpecStatus] non-override status '${status}' for ${slug} normalized to NULL (override-only column: deferred/folded)`);
    stored = null;
  }
  const admin = createAdminClient();
  // Park signal lives on the `deferred` BOOLEAN column, not `status`. The board's `deriveSpecCardStatus`
  // reads `row.deferred` (brain-roadmap.ts) — it never checks `status === 'deferred'` — so a status-only
  // write silently FAILS to park the spec (it falls through to the in_testing overlay; the 2026-07-03
  // incident). Keep the boolean in lockstep with the override here so `setSpecStatus` alone actually parks:
  // `deferred` when parking, cleared for EVERY other destination (folded / in_review / null all un-park).
  // This matches the canonical flag path (spec-card-state `upsertCardState` → dualWriteSpecRow → specs.deferred).
  const { error } = await admin
    .from("specs")
    .update({ status: stored, deferred: stored === "deferred", updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * Write the spec's `blocked_by` list — the spec-blockers enforcement point (the build pipeline holds a spec
 * until every slug in this array has shipped). The caller computes the merged/ordered list (e.g. the
 * milestone-sequence reconciler's order-preserving union); this just persists it. A slug-resolved single
 * UPDATE within a workspace.
 */
export async function setSpecBlockers(
  workspaceId: string,
  slug: string,
  blockedBy: string[],
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({ blocked_by: blockedBy, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * spec-review-pass-always-stamps-review-passed-flag Phase 1 — the narrow SDK writer that stamps the
 * DURABLE `specs.vale_review_passed_at` timestamp (build-gate-durable-review-signal). The primary
 * pass path already dual-writes this via [[spec-card-state]] `markSpecCardValePassed` →
 * `dualWriteSpecRow`, but that path is best-effort (a mirror hiccup is silently swallowed). This
 * writer is the INVARIANT GUARD called by [[../agents/spec-review]] `assertDurableReviewPassStamp`
 * after the pass to force the stamp when the mirror write dropped it — errors THROW so the caller
 * refuses to record a `spec_review_passed` `director_activity` row when the durable stamp isn't in
 * place. Returns `true` when the write actually stamped the row (was NULL, now `now()`), `false`
 * when a racing writer already stamped it (the compare-and-set `.is(vale_review_passed_at,null)`
 * matched 0 rows) or the row is missing (folded). Idempotent: caller should read first and only
 * call this when the current stored value is NULL.
 */
export async function stampSpecValeReviewPassed(
  workspaceId: string,
  slug: string,
): Promise<boolean> {
  const admin = createAdminClient();
  const stampedAt = new Date().toISOString();
  const { data, error } = await admin
    .from("specs")
    .update({ vale_review_passed_at: stampedAt, updated_at: stampedAt })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .is("vale_review_passed_at", null)
    .select("id");
  if (error) throw error;
  const stamped = (data ?? []).length > 0;
  if (stamped) invalidateSpecCache(workspaceId, slug);
  return stamped;
}

/**
 * Re-parent a spec — set the free-text `parent` prose + the typed `parent_kind`/`parent_ref` pair (and the
 * `milestone_id` FK) in ONE slug-resolved UPDATE, without round-tripping the whole body through `upsertSpec`
 * (which replaces phases). The narrow SDK writer for the parent columns — sibling to `setSpecBlockers` /
 * `setSpecStatus` (no raw PM SQL outside the SDK; `_check-pm-sdk-compliance` enforces it).
 *
 * one-off-spec-parent: a one-off spec's home is a function MANDATE (`kind:"mandate"`,
 * `ref:"{owner}#{mandate-slug}"`, `milestoneId:null`); a goal-bound spec's is a MILESTONE
 * (`kind:"milestone"`, `milestoneId:"<goal_milestones.id>"`). Pass the `parent` prose so it names the same
 * mandate/milestone the typed pair points at (Vale reads the prose). Undefined fields are left untouched.
 */
export async function setSpecParent(
  workspaceId: string,
  slug: string,
  patch: {
    parent?: string;
    parentKind?: "function" | "mandate" | "milestone" | null;
    parentRef?: string | null;
    milestoneId?: string | null;
    relatedSpec?: string | null;
  },
): Promise<void> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.parent !== undefined) fields.parent = patch.parent;
  if (patch.parentKind !== undefined) fields.parent_kind = patch.parentKind;
  if (patch.parentRef !== undefined) fields.parent_ref = patch.parentRef;
  if (patch.milestoneId !== undefined) fields.milestone_id = patch.milestoneId;
  // no-spec-parent — the origin-spec LINK moves off `parent` onto its own column.
  if (patch.relatedSpec !== undefined) fields.related_spec = patch.relatedSpec;
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update(fields)
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * Set the spec's `auto_build` flag — the owner's "auto-build is on/off for this spec" toggle (the init/groom
 * lanes skip a spec with `auto_build=false`; the CEO commissioning a build flips it on). The only narrow SDK
 * writer for this column outside a full `upsertSpec` re-author, so a one-off (the CEO re-opening a stuck
 * spec) can flip it without round-tripping the whole body. A slug-resolved single UPDATE within a workspace —
 * sibling to `setSpecBlockers` / `setSpecStatus`. No raw PM SQL outside the SDK (the `_check-pm-sdk-compliance`
 * guard).
 */
export async function setSpecAutoBuild(
  workspaceId: string,
  slug: string,
  autoBuild: boolean,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({ auto_build: autoBuild, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * Stamp a ONE-SHOT spec's card-level merge provenance on `specs.merged_pr` + `specs.last_merge_sha` — the
 * spec-status-phase-pr-provenance Phase 1 chain for a zero-phase spec (the single merge ships the whole
 * spec, and there's no `spec_phases` slot to carry the PR/SHA, so it lands on the parent row). For a
 * multi-phase spec the per-phase `stampPhaseShipped` is the provenance writer; this is the one-shot path.
 * `pr` may be null (a merge with no PR); `merge_sha` is the commit that shipped it.
 */
export async function stampSpecMergeProvenance(
  workspaceId: string,
  slug: string,
  provenance: { pr: number | null; merge_sha: string | null },
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({
      merged_pr: provenance.pr,
      last_merge_sha: provenance.merge_sha,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * spec-goal-branch-pm-flow M4 — stamp a spec's "on the goal branch" marker. Records `specs.goal_branch_sha`,
 * the `goal/{goal-slug}` merge commit SHA the moment this spec's `claude/build-{slug}` branch merged onto its
 * goal branch ([[../specs/spec-goal-branch-pm-flow]] §M4, `promoteEligibleSpecsToGoalBranch`). This is the
 * durable, M5-consumed seam: M5 (atomic goal→main promotion) reads "every spec in the goal has a
 * goal_branch_sha" to detect goal-complete; the claim-time blocked_by gate reads it to clear a GOAL-MATE
 * blocker (which never ships to main until M5). Pass `null` to CLEAR (e.g. a goal branch was rebuilt).
 *
 * The ONLY sanctioned writer for `specs.goal_branch_sha` — no raw PM SQL (the `_check-pm-sdk-compliance`
 * guard). Sibling to `stampSpecMergeProvenance`: a slug-resolved single UPDATE. It writes NEITHER status NOR
 * merge_sha — being on the goal branch is NOT shipped; the build_sha'd phases stay `in_progress` until M5
 * flips them on the atomic main promotion.
 */
export async function stampSpecGoalBranchSha(
  workspaceId: string,
  slug: string,
  goalBranchSha: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("specs")
    .update({ goal_branch_sha: goalBranchSha, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("slug", slug);
  if (error) throw error;
  invalidateSpecCache(workspaceId, slug);
}

/**
 * spec-goal-branch-pm-flow M4 — "is this spec ON its goal branch?" Read helper over `specs.goal_branch_sha`:
 * true once [[stampSpecGoalBranchSha]] has stamped it (its `claude/build-{slug}` branch merged onto
 * `goal/{goal-slug}`). The claim-time blocked_by gate reads this to clear a GOAL-MATE blocker (a goal-mate
 * never ships to main until M5's atomic promotion, so "shipped" is the wrong clearance signal for it — "on
 * the goal branch" is). Returns false for a missing spec / unstamped row. Fails CLOSED on a read error (an
 * unknown goal-branch state must NOT release a dependent — better to hold than to build on absent code).
 */
export async function isSpecOnGoalBranch(workspaceId: string, slug: string): Promise<boolean> {
  try {
    const spec = await getSpec(workspaceId, slug);
    return !!spec?.goal_branch_sha;
  } catch {
    return false; // fail closed — unknown goal-branch state must not clear a blocker
  }
}

/** spec-goal-branch-pm-flow M4 — one spec's goal-branch membership state (the unit `goalBranchState` returns
 *  per spec). `onGoalBranch` is true iff `goalBranchSha` is set. */
export interface GoalBranchSpecState {
  slug: string;
  /** The stored OVERRIDE-ONLY `specs.status` column (specs-status-override-only): a lifecycle override
   *  (in_review / deferred / folded) or `null` when status is purely derived from the phase rollup. M5 cares
   *  about onGoalBranch, not this; surfaced for diagnostics only. */
  status: SpecStatus | null;
  goalBranchSha: string | null;
  onGoalBranch: boolean;
}

/** spec-goal-branch-pm-flow M4 — the whole-goal goal-branch state. `allOnGoalBranch` is the M5 trigger
 *  signal: every linked spec is on the goal branch ⇒ the goal is ready for the atomic goal→main promotion. */
export interface GoalBranchState {
  goalSlug: string;
  specs: GoalBranchSpecState[];
  /** true iff there is ≥1 spec AND every spec has a `goal_branch_sha`. An empty goal is NOT complete. */
  allOnGoalBranch: boolean;
}

/**
 * spec-goal-branch-pm-flow M4 — the goal-branch state for a whole goal: every spec linked to `goalSlug`'s
 * milestones, each tagged with whether it's `onGoalBranch` (its branch merged onto `goal/{goal-slug}`). This
 * is the clean seam M5 (atomic-goal-promotion-to-main) consumes: `allOnGoalBranch === true` means every spec
 * in the goal is integrated on the goal branch, so the goal is ready for its atomic goal→main merge + the
 * build_sha→shipped flip.
 *
 * Resolves goal → milestones → specs through `goals-table` + `specsForMilestone` (no raw PM tables). M4
 * exposes this read-only helper; it performs NO promotion itself. Returns `allOnGoalBranch:false` for an
 * unknown/empty goal (nothing to promote).
 */
export async function goalBranchState(workspaceId: string, goalSlug: string): Promise<GoalBranchState> {
  const { getGoal } = await import("@/lib/goals-table");
  const goal = await getGoal(workspaceId, goalSlug);
  if (!goal) return { goalSlug, specs: [], allOnGoalBranch: false };
  const milestoneIds = goal.milestones.map((m) => m.id);
  const seen = new Map<string, SpecRow>();
  for (const mId of milestoneIds) {
    for (const s of await specsForMilestone(workspaceId, mId)) seen.set(s.slug, s);
  }
  const specs: GoalBranchSpecState[] = Array.from(seen.values()).map((s) => ({
    slug: s.slug,
    status: s.status,
    goalBranchSha: s.goal_branch_sha,
    onGoalBranch: !!s.goal_branch_sha,
  }));
  const allOnGoalBranch = specs.length > 0 && specs.every((s) => s.onGoalBranch);
  return { goalSlug, specs, allOnGoalBranch };
}

/** One orphan `spec_phases` row — a child whose parent `specs` row is gone (FK cascade should have killed
 *  it; a survivor is a data-integrity bug). */
export interface OrphanPhaseAnomaly {
  phase_id: string;
  spec_id: string;
  position: number;
  status: Phase;
}

/** One provenance-gap phase — `status='shipped'` with both `pr` and `merge_sha` null (the merge that
 *  shipped it was never recorded). Resolved to its parent spec's slug + workspace. */
export interface ProvenanceGapAnomaly {
  slug: string;
  workspace_id: string;
  position: number;
}

export interface SpecPhaseAnomalies {
  /** spec_phases rows whose parent specs row is missing. Workspace can't be resolved (no parent), so these
   *  are global — the integrity rail surfaces them regardless of the requesting workspace. */
  orphans: OrphanPhaseAnomaly[];
  /** Shipped phases (in the requested workspace) carrying no PR + no merge_sha. */
  provenanceGaps: ProvenanceGapAnomaly[];
}

/**
 * Integrity-scan reader for the spec_phases anomaly sweep (the reconciler's surface-don't-auto-correct
 * rail): returns (a) ORPHAN spec_phases rows whose parent `specs` row is missing, and (b) PROVENANCE-GAP
 * phases — `status='shipped'` with both `pr` and `merge_sha` null. Sourced from the
 * `list_spec_phase_anomalies(uuid)` RPC (supabase/migrations/20261003120000_list_spec_phase_anomalies_rpc.sql):
 * the spec_phases LEFT JOIN specs runs SERVER-SIDE, so no id array crosses the wire — retiring the
 * residual `.in("id", specIds.slice(...))` batch loop that dodged the ~16KB undici header cap
 * (UND_ERR_HEADERS_OVERFLOW). Read-only; folded specs are excluded from the gap set (a folded spec is
 * archived, its provenance no longer actionable). Orphans are global by nature (no parent row to read
 * a workspace from), so the orphan set is not workspace-filtered.
 */
export async function listSpecPhaseAnomalies(workspaceId: string): Promise<SpecPhaseAnomalies> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("list_spec_phase_anomalies", {
    p_workspace_id: workspaceId,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    kind: "orphan" | "provenance_gap";
    phase_id: string;
    spec_id: string;
    position: number;
    status: Phase;
    slug: string | null;
    workspace_id: string | null;
  }>;

  const orphans: OrphanPhaseAnomaly[] = [];
  const provenanceGaps: ProvenanceGapAnomaly[] = [];
  for (const r of rows) {
    if (r.kind === "orphan") {
      orphans.push({ phase_id: r.phase_id, spec_id: r.spec_id, position: r.position, status: r.status });
    } else if (r.slug !== null && r.workspace_id !== null) {
      provenanceGaps.push({ slug: r.slug, workspace_id: r.workspace_id, position: r.position });
    }
  }
  return { orphans, provenanceGaps };
}
