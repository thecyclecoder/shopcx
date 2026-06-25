# goals

The goal card row for every finite company goal / BHAG — title, body, outcome, success_metric, owner, proposer_function, status, and the `parent_goal_id` self-ref. ONE row per `(workspace_id, slug)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**The top tier of the work hierarchy** ([[../project-management]]) — `Goal → Milestone → Spec → Phase`. The MILESTONES that decompose a goal live in [[goal_milestones]] (a child table). Specs link to a milestone via `specs.milestone_id` ([[specs]]); standalone specs (function-mandate work, regressions, fix-specs) carry `milestone_id=null`.

**A SubGoal is just a goal with a `parent_goal_id`** — NOT a separate table, per the CEO-locked design contract. Most goals have no parent. A goal CAN be (re)assigned under another goal at any time via a single `UPDATE goals SET parent_goal_id=…` (the `goals_no_cycle` trigger rejects a move that would close a loop).

**Today** the goal markdown still lives in `docs/brain/goals/*.md` and [[../libraries/brain-roadmap]] `parseGoal` (L868) / `getGoals` (L1004) reads them. This table holds the parallel rows; once [[../specs/goal-readers-from-db-retire-parsegoal]] flips the readers the markdown is no longer authoritative.

**Workspace-scoped.** RLS: any authenticated user reads; service role does all writes (the writers hold the creds). No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 minus any status marker |
| `body` | `text` | the goal's full prose — outcome + why-now + model + target + success-metric + decomposition narrative (the markdown today) |
| `outcome` | `text?` | the **Outcome:** one-paragraph line, lifted out for the board's at-a-glance summary |
| `success_metric` | `text?` | the **Success metric:** line — the planner's gap-analysis anchor ([[../skills/plan-goal]]) |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform`. Free-text (no hard FK, matches `specs.owner`) |
| `proposer_function` | `text?` | the **Proposed-by:** function — set by [[../specs/director-proposed-goals]] when a director authored the goal. Null for CEO-authored goals |
| `parent_goal_id` | `uuid?` | self-ref → `goals(id)` on delete cascade. Set → this goal is a SubGoal. NOT a separate table |
| `status` | `text` | `proposed ｜ greenlit ｜ complete ｜ folded` · CHECK-constrained · default `proposed` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`goals_ws_slug` — a **unique index** on `(workspace_id, slug)`. The backfill and every future writer go through this `onConflict` key.

## Status — rolled up + greenlight-gated

`goals.status` follows two paths:

- **Auto-rollup** by the trigger `goal_milestones_rollup` (on [[goal_milestones]]) → `public.roll_up_goal_status(goal_id)`. Flips `greenlit → complete` when EVERY child milestone's `status='complete'`. Never overwrites `proposed`, `complete`, or `folded`.
- **Explicit `proposed → greenlit`** — the CEO's greenlight action ([[../specs/goal-greenlight-button-and-author-writes-db]]). Hard rail: the rollup will NEVER auto-flip a `proposed` goal to `complete` — a still-proposed goal whose milestones happen to all be done stays `proposed` until the CEO greenlights it.

## `parent_goal_id` cycle protection

The `goals_no_cycle` trigger (BEFORE INSERT / UPDATE OF `parent_goal_id`) walks the parent chain (depth-capped at 64) and rejects an UPDATE that would close a loop (G1 → G2 → G1) — the rail. The design contract allows reassignment ("a goal CAN be (re)assigned under another goal at any time"), so the move itself is one UPDATE; only the cycle is blocked.

## Reads / writes

- **Reader cutover** is owned by [[../specs/goal-readers-from-db-retire-parsegoal]] — until then `getGoals` / `getGoal` ([[../libraries/brain-roadmap]] L1004+) still read markdown. This table is the secondary copy.
- **Writer surface** is [[../libraries/goals-table]] (added in [[../specs/goals-milestones-tables-and-backfill]] Phase 2) — `getGoal` / `listGoals` / `upsertGoal` / `setGoalStatus` / `setMilestoneStatus` / `attachSpecToMilestone`.
- **One-time backfill** from `docs/brain/goals/*.md` lives in [[../recipes/backfill-goals-from-markdown]] ([[../specs/goals-milestones-tables-and-backfill]] Phase 3).

## Migration

- `supabase/migrations/20260714120000_goals_and_goal_milestones.sql` — initial tables + rollup functions + triggers + cycle guard + `specs.milestone_id` FK · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`

## Related

[[goal_milestones]] · [[specs]] · [[spec_phases]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-fold-from-db-row]] · [[../goals/db-driven-specs]] · [[../project-management]]
