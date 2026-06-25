# goal_milestones

ONE ROW PER MILESTONE of every goal — the title (e.g. `M1 — The spec body in the DB`), the body (the markdown under the `### M{N}` heading), the 1-indexed `position`, and the rolled-up `status`. A child table of [[goals]], keyed by `(goal_id, position)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Why a TABLE, not a jsonb array.** Milestone ids are STABLE across reorders + retitles. [[specs]] rows reference a milestone via the [[specs#columns|`milestone_id`]] FK (`on delete set null`) — a jsonb destroy+recreate to retitle a milestone would silently unattach every spec pointing at it. The relational shape mirrors [[spec_phases]].

**Workspace-scoped via the parent** (inherited from `goals.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across reorders + retitles (the lift-a-thing rule) |
| `goal_id` | `uuid` | FK → `goals(id)` on delete cascade |
| `position` | `int` | 1-indexed — the ordering surface. Unique per `(goal_id, position)` |
| `title` | `text` | e.g. `M1 — The spec body in the DB` |
| `body` | `text?` | the markdown block under the `### M{N}` heading in the goal page |
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `planned` · **trigger-maintained** |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill replaces milestones under the same `goal_id` keyed by position; an `upsertGoal` writer ([[../libraries/goals-table]]) renumbers positions while preserving ids.

## Trigger — `goal_milestones_rollup`

After insert / update / delete on this table, `public.roll_up_goal_status(goal_id)` recomputes the parent `goals.status`. The trigger never auto-flips a `proposed` goal to `greenlit` (CEO action only — see [[goals]] § Rolled-up status). It only flips a `greenlit` goal to `complete` when every milestone is `complete`.

## Trigger — `specs_milestone_rollup` (on [[specs]])

A row-level trigger on [[specs]] (AFTER INSERT/DELETE/UPDATE OF status, milestone_id) calls `public.roll_up_milestone_status(milestone_id)`:

- any spec `in_progress` → milestone `in_progress`
- all child specs `shipped|folded` → milestone `complete`
- otherwise → milestone `planned`

A spec move that changes `milestone_id` recomputes BOTH the old + the new milestone (so dropping the last spec drops the milestone back to `planned`).

**Hard rail:** if either rollup trigger is dropped, the spec→milestone→goal status chain falls back to app-code maintenance — the same drift class [[../specs/spec-review-agent]] caught for shipped-with-1-phase will return at the goal layer.

## Migration

- `supabase/migrations/20260714120000_goals_and_goal_milestones.sql` — initial table + rollup function + triggers · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts`

## Related

[[goals]] · [[specs]] · [[spec_phases]] · [[../libraries/brain-roadmap]] · [[../libraries/goals-table]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../goals/db-driven-specs]]
