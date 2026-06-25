# libraries/specs-table

The read/write surface for the DB-resident spec body — [[../tables/specs]] (the card) + [[../tables/spec_phases]] (the per-phase rows). Authored by [[../specs/spec-body-table-and-backfill]] Phase 2; parallel to [[spec-card-state]] (status-only mirror) until [[../specs/spec-readers-from-db-retire-parser]] (M3) retires the markdown parser.

**File:** `src/lib/specs-table.ts`

## Why this exists

[[../specs/spec-body-table-and-backfill]] adds the relations [[../tables/specs]] + [[../tables/spec_phases]] so the spec body is queryable + indexable in the DB (and so a phase can move between specs preserving its stable id + PR/SHA provenance — see below). This module is the canonical writer + read surface those rows are managed through. NO reader has been retargeted yet — `getRoadmap` / `getSpec` / the board still read markdown via [[brain-roadmap]] in this milestone; the [[../recipes/backfill-specs-from-markdown]] one-time backfill seeds the rows so M2/M3 can lean on them.

## Types

- **`SpecStatus`** = `'in_review' ｜ 'planned' ｜ 'in_progress' ｜ 'shipped' ｜ 'deferred' ｜ 'folded'` — the `specs.status` enum (CHECK-constrained in the migration). Includes `in_review` ([[../specs/spec-review-agent]]) and `folded` ([[../goals/db-driven-specs]] M4). The DB trigger keeps it consistent with the child [[../tables/spec_phases]] rows (terminal-ish `in_review` / `folded` excepted).
- **`Phase`** — re-exported from [[brain-roadmap]] so callers don't churn imports. `'planned' ｜ 'in_progress' ｜ 'shipped' ｜ 'rejected'`.
- **`SpecRow`** — `{ id, workspace_id, slug, title, summary, owner, parent, blocked_by, priority, deferred, intended_status, status, intended_status_set_by, repair_signature, auto_build, milestone_id, created_at, updated_at, phases: SpecPhaseRow[] }` — the parent + joined ordered phases.
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

All writers route through `createAdminClient()` (service-role; the RLS policy `specs_service` / `spec_phases_service` grants full access). No client-side writes.

## Not atomic across parent + children

supabase-js has no transaction surface, so `upsertSpec` is a sequence of writes (UPSERT specs, then DELETE / UPDATE / INSERT phases). The trigger keeps `specs.status` consistent after each write, and re-running the same call is idempotent (position-keyed REPLACE is deterministic). Callers requiring true atomicity must compose at the SQL layer.

## Callers

- **[[../recipes/backfill-specs-from-markdown]]** (`scripts/backfill-specs-from-markdown.ts`) — runs [[brain-roadmap]] `parseSpec` ONE LAST TIME over `docs/brain/specs/*.md` and upserts the rows.
- Future M2/M3 writers (authoring + reader cutover) will land here as [[../specs/spec-authoring-writes-db-and-worker-materialize]] / [[../specs/spec-readers-from-db-retire-parser]] flips.

## Gotchas

- **The trigger is the rail.** Don't write `specs.status='shipped'` directly while a phase is still `planned` — the next phase write will roll it back. That's the DB-enforced rule that kills the [[../specs/spec-review-agent]] "shipped with 1 phase" class.
- **`in_review` / `folded` are not auto-cleared.** The rollup early-returns on those; an explicit status flip ([[spec-card-state]] `applyAdaDisposition`, the fold worker) is required.
- **`upsertSpec` preserves provenance.** Existing `(spec_id, position)` rows keep their `id` + `pr` + `merge_sha` unless the caller passes new values. The backfill relies on this so it never destroys a per-phase PR tag while resyncing markdown.
- **`movePhase` requires a free destination slot.** The `(spec_id, position)` unique constraint will reject a move onto an occupied position; callers either renumber siblings first or pop the destination's existing phase elsewhere.
- **`Phase`'s `rejected` is NOT a `specs.status` value.** It's a phase-level state. A whole-spec rolled-up status never goes to `rejected`.

## Related

[[../tables/specs]] · [[../tables/spec_phases]] · [[brain-roadmap]] · [[spec-card-state]] · [[../recipes/backfill-specs-from-markdown]] · [[../specs/spec-body-table-and-backfill]] · [[../specs/spec-readers-from-db-retire-parser]] · [[../specs/spec-authoring-writes-db-and-worker-materialize]] · [[../specs/spec-status-phase-pr-provenance]] · [[../goals/db-driven-specs]]
