# goal_milestones

ONE ROW PER `### M{N} —` sub-section of the goal markdown's `## Decomposition` block — `title`, `body`, `position`, and the rolled-up `status`. A child table of [[goals]], keyed by `(goal_id, position)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

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
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `planned` · **Trigger-maintained** (see Rollup) |
| `created_at` | `timestamptz` | default `now()` — preserved across reorders |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill ([[../recipes/backfill-goals-from-markdown]]) replaces milestones under the same `goal_id` keyed by position; future writers preserve `id` on reorder.

## Trigger — `goal_milestones_rollup`

After insert / update of `status, goal_id` / delete on this table, `public.roll_up_goal_status(goal_id)` recomputes the parent `goals.status` (see [[goals]] § Rolled-up status — only flips `greenlit → complete`, never `proposed → complete`).

## Trigger — `specs_milestone_rollup`

Lives on [[specs]] but feeds this table: any change to `specs.status` or `specs.milestone_id` calls `public.roll_up_milestone_status(milestone_id)` here. The rule: any child spec `in_progress` → milestone `in_progress`; all child specs `shipped|folded` → milestone `complete`; otherwise `planned`. A spec moving between milestones (`UPDATE specs SET milestone_id=…`) rolls up BOTH the old and new milestone in one trigger pass.

**Hard rail:** if these triggers are ever dropped, a milestone can be `complete` while a child spec is still `planned` — the rollup is the guarantee that the board state matches reality.

## FK target

[[specs]] `milestone_id` references this table — `on delete set null`. A spec without a milestone (a function-mandate fix, a regression, an ad-hoc spec) is the explicit zero-milestone shape and keeps `milestone_id=null`. Deleting a milestone unattaches its specs rather than orphaning them.

## Migration

- `supabase/migrations/20260725130000_goals_and_goal_milestones.sql` — initial table + rollup function + trigger · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts` (per [[../recipes/backfill-goals-from-markdown]])

## Related

[[goals]] · [[specs]] · [[spec_phases]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../goals/db-driven-specs]]
