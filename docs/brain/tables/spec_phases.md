# spec_phases

ONE ROW PER PHASE of every spec — the body content (`title`, `body`), the lifecycle (`status`), the per-phase PR provenance (`pr`, `merge_sha`), and the per-phase `verification` block. A child table of [[specs]], keyed by `(spec_id, position)`. Authored by [[../specs/spec-body-table-and-backfill]] (M1 of [[../goals/db-driven-specs]]).

**Why a TABLE, not a jsonb array.** Phases are a relation specifically so a phase can MOVE between specs (lift P5 into a new deferred spec) via a single `UPDATE spec_phases SET spec_id=…, position=…` that preserves the phase's stable `id`, `pr`, `merge_sha`, and `created_at`. A jsonb-style destroy+recreate would BREAK the per-phase PR provenance chain ([[../specs/spec-status-phase-pr-provenance]]) — the exact gotcha that motivated the relation.

**Workspace-scoped via the parent** (inherited from `specs.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across moves (the lift-a-phase use case) |
| `spec_id` | `uuid` | FK → `specs(id)` on delete cascade |
| `position` | `int` | 1-indexed — the ordering surface. Unique per `(spec_id, position)` |
| `title` | `text` | the phase title (e.g. `Phase 1 — schema migration`) |
| `body` | `text` | the phase content as the brain renders it: bullets, prose, code. Markdown-as-text |
| `status` | `text` | `planned ｜ in_progress ｜ shipped ｜ rejected` · CHECK-constrained · default `planned` |
| `pr` | `int?` | the PR # that SHIPPED this phase ([[../specs/spec-status-phase-pr-provenance]]). Provable, not inferred |
| `merge_sha` | `text?` | the merge commit SHA backing the PR # above — provenance for "shipped" |
| `verification` | `text?` | the per-phase `## Verification` block when authored ([[../specs/verification-guides]]) |
| `created_at` | `timestamptz` | default `now()` — preserved across moves |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`spec_phases_spec_position` — a **unique index** on `(spec_id, position)`. The backfill replaces phases under the same `spec_id` keyed by position; `movePhase` ([[../libraries/specs-table]]) renumbers position on the destination.

## Status derives from phases (no trigger)

The parent spec's planned/in_progress/shipped status is DERIVED from this table by the readers ([[../libraries/brain-roadmap]] `deriveStatus` / `rollupPhaseStatus`). The old `spec_phases_rollup` trigger + `roll_up_spec_status` were dropped in `derive-rollup-status` P3 (migration `20260725160000`) — `specs.status` is no longer auto-written from a phase change. Because the deriver always recomputes from the live phase set, the [[../specs/spec-review-agent]] "shipped with 1 phase" bug can't surface: a stale `specs.status='shipped'` is ignored when a phase is still `planned`.

## Provenance preservation (movePhase)

The lift-a-phase primitive `movePhase(phaseId, newSpecId, newPosition)` is a single UPDATE that preserves `id`, `pr`, `merge_sha`, and `created_at`. No rollup fires — the readers recompute both the source spec (likely drops `shipped`→`in_progress`) and the destination spec from their phase sets at read time.

## Migration

- `supabase/migrations/20260713120000_specs_and_spec_phases.sql` — initial table + rollup trigger · apply: `scripts/apply-specs-tables-migration.ts` · verify: `scripts/_verify-specs-schema.ts`
- `supabase/migrations/20260725160000_drop_rollup_triggers_and_milestone_status.sql` — `derive-rollup-status` P3: dropped `spec_phases_rollup` + `roll_up_spec_status`; status now derives at read time
- One-time backfill from markdown ([[../specs/spec-body-table-and-backfill]] Phase 3): `scripts/backfill-specs-from-markdown.ts`

## Related

[[specs]] · [[spec_card_state]] · [[../libraries/specs-table]] · [[../libraries/brain-roadmap]] · [[../specs/spec-status-phase-pr-provenance]] · [[../specs/spec-body-table-and-backfill]]
