# goal_milestones

ONE ROW PER `### M{N} —` sub-section of the goal markdown's `## Decomposition` block — `title`, `body`, `position`. A child table of [[goals]], keyed by `(goal_id, position)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Completion is PURELY DERIVED — there is NO `status` column.** Milestone planned/in_progress/complete is computed from the child specs at read time ([[../libraries/brain-roadmap]] `milestoneRowToCard`): no linked specs ⇒ planned (completion 0); every linked spec shipped|folded ⇒ complete; any progress ⇒ in_progress. The old `status` column + its rollup trigger were dropped in `derive-rollup-status` P3 (migration `20260725160000`) — a milestone has no explicit/terminal state of its own, so nothing needed to be stored.

**Why a TABLE, not a jsonb array.** Same rule [[spec_phases]] enforces — the milestone `id` is **STABLE across reorders + retitles**. [[specs]] FK into this table via `specs.milestone_id`; a jsonb-style destroy+recreate would silently unattach every spec under the milestone (the FK is `on delete set null`). A reorder is a single `UPDATE goal_milestones SET position=…` that preserves the `id`.

**Workspace-scoped via the parent** (inherited from `goals.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across reorders + retitles |
| `goal_id` | `uuid` | FK → `goals(id)` on delete cascade |
| `position` | `int` | 1-indexed — the milestone ordering surface. Unique per `(goal_id, position)` |
| `title` | `text` | the milestone title (e.g. `M1 — The spec body in the DB`) |
| `body` | `text?` | the `### M{N}` block content as the brain renders it — bullets, prose. Markdown-as-text |
| `why` | `text?` | [[../specs/pm-structured-intent-and-refs]] Phase 1 — plain-language WHY this milestone exists inside its goal. Paired with `what`. Written when the authoring surface supplies it ([[../libraries/goals-table]] `upsertGoal` persists on non-undefined). Rendered on the detail page as the milestone's intent header |
| `what` | `text?` | [[../specs/pm-structured-intent-and-refs]] Phase 1 — plain-language WHAT changes when this milestone lands. Paired with `why`. Distinct from the free-text `body` (implementation notes) |
| `created_at` | `timestamptz` | default `now()` — preserved across reorders |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill ([[../recipes/backfill-goals-from-markdown]]) replaces milestones under the same `goal_id` keyed by position; future writers preserve `id` on reorder.

## Status is derived, not rolled up (no triggers)

There are no rollup triggers on or feeding this table anymore. The original `goal_milestones_rollup` (`goal_milestones → goals.status`) and `specs_milestone_rollup` (`specs → goal_milestones.status`) triggers, plus `roll_up_goal_status` / `roll_up_milestone_status`, were dropped in `derive-rollup-status` P3 (migration `20260725160000`). The READERS now own the derivation: [[../libraries/brain-roadmap]] `milestoneRowToCard` computes milestone completion from the linked child specs, and `goalRowToCard` derives a goal `complete` from all-milestones-complete. Writers ([[../libraries/goals-table]] `upsertGoal`, `attachSpecToMilestone`) only persist structure — they never write a milestone or goal status.

## FK target

[[specs]] `milestone_id` references this table — `on delete set null`. A spec without a milestone (a function-mandate fix, a regression, an ad-hoc spec) is the explicit zero-milestone shape and keeps `milestone_id=null`. Deleting a milestone unattaches its specs rather than orphaning them.

## Migration

- `supabase/migrations/20260725130000_goals_and_goal_milestones.sql` — initial table + rollup function + trigger · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- `supabase/migrations/20260725160000_drop_rollup_triggers_and_milestone_status.sql` — `derive-rollup-status` P3: dropped the rollup triggers + functions and `DROP COLUMN status` (status is now derived by the readers)
- `supabase/migrations/20260807140000_pm_intent_why_what.sql` ([[../specs/pm-structured-intent-and-refs]] Phase 1) — adds `why` + `what` (both nullable) for the plain-language milestone intent. Written by [[../libraries/goals-table]] `upsertGoal` on non-undefined; the milestone-decomposition parser today doesn't yet produce them, so existing rows read NULL until re-authored · apply: `scripts/apply-pm-intent-why-what-migration.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts` (per [[../recipes/backfill-goals-from-markdown]])

## Related

[[goals]] · [[specs]] · [[spec_phases]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../goals/db-driven-specs]]
