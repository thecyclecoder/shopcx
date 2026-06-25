# goals

The top tier of the [[../project-management|Goal → Milestone → Spec → Phase]] hierarchy as data ([[../goals/db-driven-specs]] M5). Today `getGoals` ([[../libraries/brain-roadmap]] L1004) reads `docs/brain/goals/*.md` directly and `**Status:** proposed｜greenlit｜complete` lives in markdown — so greenlighting a goal requires editing a file and committing it (no DB flag → no UI button → the CEO literally had no surface to approve the [[../goals/db-driven-specs]] goal; it had to be hand-committed). This table is where the goal LIVES once the [[../specs/goal-readers-from-db-retire-parsegoal]] cutover lands.

A **SubGoal is just a `goals` row with a `parent_goal_id`** — NOT a separate table. The CEO-locked design contract is one self-referential relation; the goal-decomposition engine is indifferent to whether a goal has a parent.

**Workspace-scoped, RLS-protected.** Any authenticated workspace user reads; service role does all writes (mirrors [[spec_card_state]]). No client-side goal writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | the `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 title |
| `body` | `text` | the goal's full body (outcome + why + model + target + decomposition seed) |
| `outcome` | `text?` | the one-paragraph **Outcome:** line — surfaced on the board summary |
| `success_metric` | `text?` | the **Success metric:** line — the planner's gap-analysis anchor (see [[../skills/plan-goal]]) |
| `owner` | `text` | the DRI function slug (`growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform`) |
| `proposer_function` | `text?` | the **Proposed-by:** function — set by [[../specs/director-proposed-goals]] when a director authored the goal; NULL for a CEO-authored goal |
| `parent_goal_id` | `uuid?` | self-ref → `goals(id)` on delete cascade · **a SubGoal is just a goal with a parent** · cycles rejected by trigger |
| `status` | `text` | `proposed ｜ greenlit ｜ complete ｜ folded` · CHECK-constrained · default `'proposed'` · **DB-only**, never the markdown `**Status:**` line |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write (trigger) |

## Upsert spine

`goals_ws_slug` — **unique index** on `(workspace_id, slug)`. The [[../recipes/backfill-goals-from-markdown]] script UPSERTs by this; re-runs are no-ops. The board's nested-goal render walks `parent_goal_id` (indexed `goals_parent_idx`).

## Status rollup

`status` ROLLS UP from `goal_milestones.status` via the `roll_up_goal_status(goal_id)` SQL function (called by the `goal_milestones_rollup_to_goal` trigger after every milestone status change):

- All child milestones `complete` AND current status is `greenlit` → flip to `complete`.
- A `proposed` goal NEVER auto-flips to `complete` — only the CEO greenlight (the `proposed → greenlit` flip per [[../specs/goal-greenlight-button-and-author-writes-db]]) opens that door. This is the hard rail.
- A `folded` goal is terminal — the M4 fold ([[../specs/goal-fold-from-db-row]]) sets it.

The Status line in `docs/brain/goals/*.md` is NOT the source of truth — it survives only as legacy noise until [[../specs/goal-readers-from-db-retire-parsegoal]] cuts readers over.

## Acyclicity

A goal CANNOT be its own ancestor. The `goals_check_acyclic_parent` trigger walks `parent_goal_id` on INSERT and on UPDATE of `parent_goal_id`, RAISEs on a closed loop, and caps the chain depth at 32 hops as a defensive backstop. Re-assigning a goal under another goal at any time is one UPDATE — cycles bounce at the rail.

## Writers

Authored by [[../specs/goals-milestones-tables-and-backfill]] (this table + its sibling [[goal_milestones]]). The writer surface ships in Phase 2 (the [[../libraries/goals-table]] lib — `upsertGoal`, `setGoalStatus`, etc.). The one-time backfill from `docs/brain/goals/*.md` ships in Phase 3 ([[../recipes/backfill-goals-from-markdown]]).

Subsequent specs cut over the surfaces:

- [[../specs/goal-greenlight-button-and-author-writes-db]] — CEO-only one-click `proposed → greenlit` flip writes `setGoalStatus(goalId, 'greenlit', actor)`.
- [[../specs/goal-readers-from-db-retire-parsegoal]] — every reader cuts over to this table; `parseGoal` / `setGoalStatusLine` / `deriveGoalStatus` retire.
- [[../specs/goal-fold-from-db-row]] — fold writes the canonical `goals/{slug}.md` brain page and flips `status` to `folded` (PRESERVED, not deleted).

## Migration

- `supabase/migrations/20260725120000_goals_and_goal_milestones.sql` — initial table + the [[goal_milestones]] sibling + rollup functions/triggers. Apply: `scripts/apply-goals-tables-migration.ts`. Verify: `scripts/_verify-goals-schema.ts`.

## Related

[[goal_milestones]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../goals/db-driven-specs]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-fold-from-db-row]] · [[spec_card_state]] (the sibling status mirror that retires when [[../specs/spec-readers-from-db-retire-parser]] lands)
