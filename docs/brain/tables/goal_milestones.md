# goal_milestones

ONE ROW PER MILESTONE under a goal — the `position`, `title`, `body`, and the rolled-up `status`. A child table of [[goals]], keyed by `(goal_id, position)`. The typed link from [[specs]] is `specs.milestone_id` (FK → `goal_milestones(id)` on delete set null). Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Why a TABLE, not a jsonb array on `goals`.** Milestones need STABLE ids so [[specs]] can FK at them via `specs.milestone_id`. A jsonb-style destroy+recreate (the way a backfill would naturally rewrite the array) would invalidate every spec's FK, and the FK is `on delete set null` — so a destructive rewrite would silently unattach specs. The same lift-a-thing rule [[spec_phases]] follows.

**Workspace-scoped via the parent** (inherited from `goals.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across reorders (the [[specs]] `.milestone_id` FK depends on this) |
| `goal_id` | `uuid` | FK → `goals(id)` on delete cascade |
| `position` | `int` | 1-indexed — the ordering surface. Unique per `(goal_id, position)` |
| `title` | `text` | the H3 the goal markdown's `### M{N} — title` block carries |
| `body` | `text?` | the milestone description + sub-bullets under `### M{N}` |
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `planned`. **Trigger-maintained** by `specs_milestone_rollup` from child [[specs]] |
| `created_at` | `timestamptz` | default `now()` — preserved across reorders |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill ([[../recipes/backfill-goals-from-markdown]]) replaces milestones under the same `goal_id` keyed by position, preserving `id` where unchanged.

## Trigger — `specs_milestone_rollup` + `specs_milestone_rollup_upd`

After INSERT / DELETE on [[specs]] and after UPDATE OF `status, milestone_id` on [[specs]], `public.roll_up_milestone_status(milestone_id)` recomputes this milestone's `status`. A spec move (milestone_id change) fires the rollup on BOTH the old and the new milestone.

The rule (mirrors [[../libraries/brain-roadmap]] `deriveMilestoneStatus`):

- `shipped` and `folded` count as **complete**.
- `in_progress` and the others (`planned`, `in_review`, `deferred`) do not.
- All children complete → `complete` · any `in_progress` or any complete-but-not-all → `in_progress` · otherwise `planned`.

**Hard rail:** if this trigger is ever dropped, a milestone can read `complete` while a child spec is still `in_progress` — the goal-side equivalent of the [[../specs/spec-review-agent]] "shipped with 1 phase" class of bug.

## Trigger — `goal_milestones_rollup`

After INSERT / UPDATE / DELETE on this table, `public.roll_up_goal_status(goal_id)` recomputes the parent [[goals]] row's `status`. See [[goals]] for the rail (`proposed` is never auto-flipped; only `greenlit → complete` is automatic).

## FK from [[specs]]

`specs.milestone_id uuid` → `goal_milestones(id) on delete set null`. A spec without a milestone (a standalone fix-spec, regression, or function-mandate spec) keeps `milestone_id=null` — that's the explicit zero-milestone shape, not a bug. If a milestone is ever deleted, its specs are unattached (their own status + history survives).

## Migration

- `supabase/migrations/20260726120000_goals_and_goal_milestones.sql` — initial table + rollup triggers + the `specs.milestone_id` FK constraint · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts`

## Related

[[goals]] · [[specs]] · [[spec_phases]] · [[../libraries/brain-roadmap]] · [[../libraries/goals-table]] · [[../specs/goals-milestones-tables-and-backfill]]
