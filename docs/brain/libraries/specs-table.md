# libraries/specs-table

The read/write surface for the DB-resident spec body — [[../tables/specs]] (the card) + [[../tables/spec_phases]] (the per-phase rows). Authored by [[../specs/spec-body-table-and-backfill]] Phase 2; parallel to [[spec-card-state]] (status-only mirror) until [[../specs/spec-readers-from-db-retire-parser]] (M3) retires the markdown parser.

**File:** `src/lib/specs-table.ts`

## Why this exists

[[../specs/spec-body-table-and-backfill]] adds the relations [[../tables/specs]] + [[../tables/spec_phases]] so the spec body is queryable + indexable in the DB (and so a phase can move between specs preserving its stable id + PR/SHA provenance — see below). This module is the canonical writer + read surface those rows are managed through. NO reader has been retargeted yet — `getRoadmap` / `getSpec` / the board still read markdown via [[brain-roadmap]] in this milestone; the [[../recipes/backfill-specs-from-markdown]] one-time backfill seeds the rows so M2/M3 can lean on them.

## Types

- **`SpecStatus`** = `'in_review' ｜ 'planned' ｜ 'in_progress' ｜ 'shipped' ｜ 'deferred' ｜ 'folded'` — the `specs.status` enum (CHECK-constrained in the migration). Includes `in_review` ([[../specs/spec-review-agent]]) and `folded` ([[../goals/db-driven-specs]] M4). The DB trigger keeps it consistent with the child [[../tables/spec_phases]] rows (terminal-ish `in_review` / `folded` excepted).
- **`Phase`** — re-exported from [[brain-roadmap]] so callers don't churn imports. `'planned' ｜ 'in_progress' ｜ 'shipped' ｜ 'rejected'`.
- **`SpecRow`** — `{ id, workspace_id, slug, title, summary, owner, parent, blocked_by, priority, deferred, intended_status, status, intended_status_set_by, repair_signature, regression_of_slug, regression_signature, auto_build, vale_pass, ada_disposition, milestone_id, merged_pr, last_merge_sha, created_at, updated_at, phases: SpecPhaseRow[] }` — the parent + joined ordered phases. `regression_of_slug` / `regression_signature` mirror the regression-agent header lines (`**Regression-of:** [[<slug>]]` / `**Regression-signature:** `<sig>``) — typed columns added in [[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 1, sibling to `repair_signature`. `merged_pr` (int) / `last_merge_sha` (text) carry a **one-shot spec's** card-level shipping PR + SHA ([[../specs/spec-status-phase-pr-provenance]]) — a zero-phase spec has no `spec_phases` slot to hold provenance, so it lands on the parent row; multi-phase specs use `spec_phases.pr` instead and leave these null.
- **`SpecPhaseRow`** — `{ id, spec_id, position, title, body, status, pr, merge_sha, verification, created_at, updated_at }`. `position` is 1-indexed.
- **`SpecRowInput`** / **`SpecPhaseInput`** — the writable field sets `upsertSpec` accepts.

## Exports

- **`getSpec(workspaceId, slug)`** → `SpecRow | null` — the parent row + its [[../tables/spec_phases]] rows ordered by `position`. Read by authenticated users (RLS) — service role bypasses for backfill / writers.
- **`listSpecs(workspaceId, filter?)`** → `SpecRow[]` — every spec in a workspace, optionally filtered by `{ status, owner, milestone_id }`. Phases joined in one extra round-trip.
- **`upsertSpec(workspaceId, row, phases)`** → `{ spec_id, phase_ids }` — the canonical write. UPSERT by `(workspace_id, slug)` + REPLACE phases under the same `spec_id`:
  - matching `(spec_id, position)` rows are UPDATED in place — preserving `id` (and `pr` / `merge_sha` unless explicitly overridden)
  - new positions INSERT (with the supplied `pr` / `merge_sha` if any)
  - vanished positions DELETE
  - the trigger rolls `specs.status` after each phase write (terminal-ish `in_review` / `folded` are left alone)
  - per-`SpecPhaseInput`: PASS `undefined` for `pr` / `merge_sha` / `verification` to PRESERVE the existing value, PASS `null` to CLEAR
- **`movePhase(phaseId, newSpecId, newPosition)`** — the **lift-a-phase-between-specs primitive**: a SINGLE `UPDATE spec_phases` that preserves the phase's `id`, `pr`, `merge_sha`, `created_at` ([[../specs/spec-status-phase-pr-provenance]] provenance chain). The trigger fires twice (old + new `spec_id`) and rolls both rollups in one transaction. The unique `(spec_id, position)` index may reject the move if the destination slot is occupied — the caller is responsible for shifting positions first when so.
- **`stampPhaseShipped(workspaceId, slug, position, { merge_sha, pr? })`** — stamp ONE phase `shipped` with its PR provenance (the canonical leaf write that advances the now-DERIVED `specs.status`). The only status-write needed to ship a phase.
- **`markPhaseInProgress(workspaceId, slug)`** / **`markRemainingPhasesShipped(workspaceId, slug)`** / **`restampPhases(...)`** — the derive-rollup-status phase-advance writers (build-start in_progress flip · fold-now "close the rest" · audit re-stamp). All move `spec_phases` rows; the readers derive `specs.status` from them.

PM-write SDK surfaces (the explicit `specs.status` / `blocked_by` / one-shot-provenance overrides — added by [[../specs/pm-db-agent-toolkit]] to retire raw `.from("specs").update(...)` from agent code):

- **`setSpecStatus(workspaceId, slug, status, actor)`** — write the EXPLICIT lifecycle override on `specs.status` (`shipped` / `folded` / `in_review` / `deferred`) — the states NOT derivable from the phase rollup. Slug-resolved single UPDATE, mirrors goals-table `setGoalStatus`. The fold worker calls this with `'folded'`; the **only** sanctioned `specs.status` writer outside `upsertSpec`.
- **`setSpecBlockers(workspaceId, slug, blockedBy: string[])`** — write `specs.blocked_by` (the spec-blockers gate the build pipeline reads). The milestone-sequence reconciler computes the order-preserving union and persists it here.
- **`stampSpecMergeProvenance(workspaceId, slug, { pr, merge_sha })`** — write a **one-shot spec's** card-level `merged_pr` + `last_merge_sha` (the zero-phase merge-webhook path in [[agent-jobs]]).
- **`listSpecPhaseAnomalies(workspaceId)`** → `{ orphans, provenanceGaps }` — the integrity-scan reader: (a) ORPHAN `spec_phases` rows whose parent `specs` row is missing (global — no parent to read a workspace from), and (b) PROVENANCE-GAP shipped phases with both `pr` + `merge_sha` null (workspace-scoped, folded-excluded). Resolves `spec_id → {slug, workspace}` internally so callers (the [[spec-drift]] reconciler's anomaly sweep) never touch raw PM tables.

All writers route through `createAdminClient()` (service-role; the RLS policy `specs_service` / `spec_phases_service` grants full access). No client-side writes.

**Raw PM-table writes are CI-forbidden outside this SDK.** `scripts/_check-pm-sdk-compliance.ts` (chained into `predeploy`) fails the build on any `.from('specs'|'spec_phases'|'goals'|'goal_milestones').update()/.insert()/.upsert()/.delete()` in `scripts/builder-worker.ts` or `src/lib/**` that isn't in this SDK (or `goals-table.ts`) and isn't on its `SANCTIONED_RAW_WRITES` allow-list. One sanctioned exception: [[spec-card-state]] `dualWriteSpecRow` (the legacy mirror dual-write, broad column set).

## Not atomic across parent + children

supabase-js has no transaction surface, so `upsertSpec` is a sequence of writes (UPSERT specs, then DELETE / UPDATE / INSERT phases). The trigger keeps `specs.status` consistent after each write, and re-running the same call is idempotent (position-keyed REPLACE is deterministic). Callers requiring true atomicity must compose at the SQL layer.

## Callers

- **[[../recipes/backfill-specs-from-markdown]]** (`scripts/backfill-specs-from-markdown.ts`) — runs [[brain-roadmap]] `parseSpec` ONE LAST TIME over `docs/brain/specs/*.md` and upserts the rows.
- **[[author-spec]]** (`src/lib/author-spec.ts`) — the dual-write chokepoint every spec-author surface routes through ([[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 1). Parses the just-committed markdown body and calls `upsertSpec`, so the DB row stays in step with the `.md` commit until [[../specs/spec-readers-from-db-retire-parser]] (M3) cuts readers over.
- **[[build-spec-materializer]]** ([[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 2; adopted by [[../specs/spec-fold-from-db-row]] Phase 1) reads `getSpec` to render a temp `.box/spec-{slug}.md` for the [[../skills/build-spec]] skill (and [[../skills/fold-to-brain]] during folding) — Bo never reads the on-disk spec body once a `public.specs` row exists, and fold-to-brain never reads `docs/brain/specs/{slug}.md`.
- **[[spec-card-state]] `upsertCardState`** ([[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 3) dual-writes the corresponding typed columns on this table (status, deferred, priority, intended_status) on every mirror flip, so the future-canonical row stays in sync with the mirror.
- **[[agent-jobs]] `applyMergedBuildEffects`** ([[../specs/spec-authoring-writes-db-and-worker-materialize]] Phase 2) double-writes per-phase PR provenance to [[../tables/spec_phases]] (`UPDATE spec_phases SET pr=…, merge_sha=… WHERE spec_id=… AND position=…`) alongside `spec_card_state.phase_states[i]` — the typed phase row is the canonical phase-PR provenance surface.
- **Fold process** ([[../specs/spec-fold-from-db-row]] Phase 1) — the box worker's `runFoldJob` calls `getSpec` with a `status='shipped'` guard to fetch shipped specs, then materializes each into `.box/spec-{slug}.md` for the fold-agent to read. After fold commits succeed, the worker updates the row to `status='folded'`. The spec row is PRESERVED (not deleted) so archive views + audit history can render it unchanged.

## Gotchas

- **The trigger is the rail.** Don't write `specs.status='shipped'` directly while a phase is still `planned` — the next phase write will roll it back. That's the DB-enforced rule that kills the [[../specs/spec-review-agent]] "shipped with 1 phase" class.
- **`in_review` / `folded` are not auto-cleared.** The rollup early-returns on those; an explicit status flip ([[spec-card-state]] `applyAdaDisposition`, the fold worker) is required.
- **`upsertSpec` preserves provenance.** Existing `(spec_id, position)` rows keep their `id` + `pr` + `merge_sha` unless the caller passes new values. The backfill relies on this so it never destroys a per-phase PR tag while resyncing markdown.
- **`movePhase` requires a free destination slot.** The `(spec_id, position)` unique constraint will reject a move onto an occupied position; callers either renumber siblings first or pop the destination's existing phase elsewhere.
- **`Phase`'s `rejected` is NOT a `specs.status` value.** It's a phase-level state. A whole-spec rolled-up status never goes to `rejected`.

## Related

[[../tables/specs]] · [[../tables/spec_phases]] · [[brain-roadmap]] · [[spec-card-state]] · [[../recipes/backfill-specs-from-markdown]] · [[../specs/spec-body-table-and-backfill]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../specs/spec-status-phase-pr-provenance]] · [[../specs/spec-fold-from-db-row]] · [[../goals/db-driven-specs]]
