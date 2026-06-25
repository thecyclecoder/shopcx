# goals

The goal card row for every entry under `docs/brain/goals/*.md` — slug, title, body, the **Outcome:** + **Success metric:** lines as their own columns, owner function, optional `proposer_function`, the self-ref `parent_goal_id` that makes a **SubGoal just a goal with a parent**, and the rolled-up `status`. ONE row per `(workspace_id, slug)`. The milestone children live in [[goal_milestones]] (one row per milestone, a child table). Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Today** goals are still parsed from `docs/brain/goals/*.md` by [[../libraries/brain-roadmap]] `parseGoal` (L868) — used ONE LAST TIME by the backfill in Phase 3 of this spec. The cutover to DB-only reads is [[../specs/goal-readers-from-db-retire-parsegoal]]; until then this table is the secondary copy. **The CEO greenlight is the only path out of `proposed`** ([[../specs/goal-greenlight-button-and-author-writes-db]]) — the rollup will NEVER auto-flip a `proposed` goal.

**Workspace-scoped** (mirrors [[specs]]). RLS: any authenticated user reads; service role does all writes. No client-side goal writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 of the goal page |
| `body` | `text` | the full goal body (outcome + why + model + target) as markdown-as-text |
| `outcome` | `text?` | the **Outcome:** paragraph lifted as its own column for the board summary |
| `success_metric` | `text?` | the **Success metric:** line — the planner's gap-analysis anchor ([[../skills/plan-goal]]) |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform` |
| `proposer_function` | `text?` | the **Proposed-by:** function set by [[../specs/director-proposed-goals]]; null for CEO-authored goals |
| `parent_goal_id` | `uuid?` | self-ref → `goals(id)` on delete cascade — a SubGoal is just a goal with a parent (CEO-locked contract) |
| `status` | `text` | `proposed ｜ greenlit ｜ complete ｜ folded` · CHECK-constrained · default `proposed`. **Trigger-maintained** |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goals_ws_slug` — a **unique index** on `(workspace_id, slug)`. The backfill and every future writer go through this `onConflict` key (insert on first write, update on repeat).

## SubGoals are not a separate relation

A **SubGoal is a `goals` row with `parent_goal_id` set** — the design contract is CEO-locked and explicit (see [[../goals/db-driven-specs]]). The board's nested render walks the self-ref to show CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5 ▸ specs ▸ phases. A goal can be (re)assigned under another goal at any time with a single `UPDATE goals SET parent_goal_id=…` — the same move-ability we want for phases.

**Cycle protection.** `goals_reject_cycle_trigger` (BEFORE INSERT/UPDATE OF parent_goal_id) walks the parent chain and rejects an UPDATE that would close a loop. Cap is 64 ancestor hops (a depth far beyond any real org-chart) — beyond that the trigger raises `goals.parent_goal_id chain too deep`.

## Rolled-up status

`goals.status` is maintained by a row-level trigger (`goal_milestones_rollup`) on [[goal_milestones]] that calls `public.roll_up_goal_status(goal_id)`. The rule is deliberately conservative:

- `proposed` is **never** auto-flipped to `greenlit`. The CEO greenlight is the only path out — [[../specs/goal-greenlight-button-and-author-writes-db]] is the action surface.
- `folded` is terminal: the rollup never overwrites it.
- A `greenlit` goal whose every `goal_milestones` row is `complete` rolls to `complete`.

This deliberately leaves a `proposed` goal at `proposed` even when all of its milestones happen to be `complete` (an impossible-in-practice shape that, if it ever occurs, surfaces the rail violation rather than silently shipping).

## Reads / writes

- **Reader cutover is [[../specs/goal-readers-from-db-retire-parsegoal]]** — until then `getGoals` / `getGoal` ([[../libraries/brain-roadmap]] L1004+) still read markdown. This table is the secondary copy.
- **CEO greenlight write surface is [[../specs/goal-greenlight-button-and-author-writes-db]]** — it calls `setGoalStatus(goalId, 'greenlit', actor)` on [[../libraries/goals-table]].
- This spec ([[../specs/goals-milestones-tables-and-backfill]]) creates the relations + the writer surface + the one-time backfill from `docs/brain/goals/*.md`.

## Migration

- `supabase/migrations/20260714120000_goals_and_goal_milestones.sql` — initial tables + rollup functions + triggers + cycle guard + specs.milestone_id FK · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts`

## Related

[[goal_milestones]] · [[specs]] · [[../libraries/brain-roadmap]] · [[../libraries/goals-table]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-fold-from-db-row]] · [[../goals/db-driven-specs]]
