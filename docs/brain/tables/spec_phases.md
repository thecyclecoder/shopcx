# spec_phases

ONE ROW PER PHASE of every spec — the body content (`title`, `body`), the lifecycle (`status`), the per-phase build/PR provenance (`build_sha` = the spec-branch commit where the phase BUILT; `pr` / `merge_sha` = the MAIN-promotion stamp), and the per-phase `verification` block. A child table of [[specs]], keyed by `(spec_id, position)`. Authored by [[../specs/spec-body-table-and-backfill]] (M1 of [[../goals/db-driven-specs]]); `build_sha` added by [[../specs/spec-goal-branch-pm-flow]] M2 ([[../lifecycles/spec-goal-branch-pm-flow]]).

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
| `pr` | `int?` | the PR # that SHIPPED this phase ([[../specs/spec-status-phase-pr-provenance]]). Provable, not inferred. Under the branch-flow ([[../specs/spec-goal-branch-pm-flow]]) set only on MAIN PROMOTION (M5) |
| `merge_sha` | `text?` | the MAIN-promotion merge commit SHA backing the PR # above — provenance for "shipped". Reserved for promotion (M5); never written by a mere spec-branch build |
| `build_sha` | `text?` | the `claude/build-{slug}` spec-branch commit SHA where this phase BUILT ([[../specs/spec-goal-branch-pm-flow]] M2). Set by `stampPhaseBuilt` the moment a phase commits on the spec branch; the phase reads `in_progress` (built, NOT shipped) until promotion. DISTINCT from `merge_sha`: `build_sha` set + `merge_sha`/`pr` null = built-on-branch. The branch-flow's "this phase is done building" signal the next-phase advance reads (not the main-merge `pr` tag) |
| `verification` | `text?` | the per-phase `## Verification` block when authored ([[../specs/verification-guides]]) |
| `why` | `text?` | [[../specs/pm-structured-intent-and-refs]] Phase 1 — plain-language WHY this phase exists inside its spec. HARD-gated at the app-layer chokepoint ([[../libraries/author-spec]] `assertEveryNodeHasIntent`). Paired with `what`. NULL only for pre-intent rows |
| `what` | `text?` | [[../specs/pm-structured-intent-and-refs]] Phase 1 — plain-language WHAT changes when this phase ships. Paired with `why`. HARD-gated at the chokepoint |
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
- `supabase/migrations/20260726120000_spec_phases_build_sha.sql` — `spec-goal-branch-pm-flow` M2: added `build_sha` (spec-branch build provenance) · apply: `scripts/apply-spec-phases-build-sha-migration.ts`
- `supabase/migrations/20260807140000_pm_intent_why_what.sql` ([[../specs/pm-structured-intent-and-refs]] Phase 1) — adds `why` + `what` for the plain-language intent layer; HARD-gated by `assertEveryNodeHasIntent` at the app-layer chokepoint (a phase with an empty intent throws before the DB write) · apply: `scripts/apply-pm-intent-why-what-migration.ts`
- One-time backfill from markdown ([[../specs/spec-body-table-and-backfill]] Phase 3): `scripts/backfill-specs-from-markdown.ts`

## Related

[[specs]] · [[spec_card_state]] · [[../libraries/specs-table]] · [[../libraries/brain-roadmap]] · [[../specs/spec-status-phase-pr-provenance]] · [[../specs/spec-body-table-and-backfill]]
