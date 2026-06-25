# libraries/goals-table

The DB-backed read/write surface for [[../tables/goals]] + [[../tables/goal_milestones]] — parallel to [[specs-table]] for the spec hierarchy. Authored by [[../specs/goals-milestones-tables-and-backfill]] Phase 2 (M5 of [[../goals/db-driven-specs]]).

**File:** `src/lib/goals-table.ts`

## Why this exists

Goals are moving from `docs/brain/goals/*.md` into [[../tables/goals]] + [[../tables/goal_milestones]] (M5 of [[../goals/db-driven-specs]]). Today the markdown is still the source of truth — [[brain-roadmap]] `parseGoal` / `getGoals` / `getGoal` read it directly. This module is the **writer surface** and the future-canonical reader: every author flow (the [[../specs/director-proposed-goals]] flow, the planner's SUBGOAL primitive, the goal-decomposition engine seeding milestones) goes through `upsertGoal`; the CEO greenlight button ([[../specs/goal-greenlight-button-and-author-writes-db]]) calls `setGoalStatus`; the planner's leaf-attach calls `attachSpecToMilestone`. Once [[../specs/goal-readers-from-db-retire-parsegoal]] cuts readers over, this becomes the only path — the markdown parse retires.

All writes go through `createAdminClient()` (service-role). The DB triggers installed by the Phase 1 migration enforce the rollup + acyclicity rails — this module never bypasses them.

## Core types

- **`GoalRow`** — one `public.goals` row (snake_case columns, matching the DB shape).
- **`MilestoneRow`** — one `public.goal_milestones` row.
- **`GoalWithMilestones`** — `GoalRow` + ordered `milestones: MilestoneRow[]`. The shape readers compose against.
- **`GoalInput`** / **`MilestoneInput`** — author inputs for `upsertGoal` (snake_case; `slug` is the upsert spine for the goal; `position` for the milestone is derived from array index + 1).
- **`GoalStatus`** = `"proposed" | "greenlit" | "complete" | "folded"`.
- **`MilestoneStatus`** = `"planned" | "in_progress" | "complete"`.
- **`ListGoalsFilter`** = `{ status?, owner?, parent_goal_id? }`.

## Key exports

- **`getGoal(workspaceId, slug)`** → `GoalWithMilestones | null` — read one goal + its milestones (ordered by position). Returns null when no row exists (markdown-fallback callers during the dual-write window).
- **`listGoals(workspaceId, filter?)`** → `GoalRow[]` — every goal in the workspace, optionally filtered by `status` / `owner` / `parent_goal_id`. Returns rows WITHOUT milestones — call `getGoal` per row for the joined shape.
- **`upsertGoal(workspaceId, goal, milestones)`** → `GoalWithMilestones` — transactional UPSERT by `(workspace_id, slug)` + REPLACE of milestones by position. **Preserves milestone `id` across retitle / body edit** (the upsert key on [[../tables/goal_milestones]] is `(goal_id, position)`), so any [[../tables/specs]]`.milestone_id` FK pointing at the milestone survives. A position no longer present is DELETED — the FK is `on delete set null` so attached specs unattach instead of cascading out. **Status on FIRST insert only**: a re-upsert on an existing row leaves `status` alone, so a CEO greenlight survives a backfill replay.
- **`setGoalStatus(goalId, status, actor)`** — the CEO-greenlight write surface ([[../specs/goal-greenlight-button-and-author-writes-db]] calls this for `proposed → greenlit`). The DB trigger `goal_milestones_rollup` handles the common `greenlit → complete` auto-flip — this is the only path for actor-driven transitions. `actor` is recorded for audit (free-text — `ceo`, the function slug, or `backfill`).
- **`setMilestoneStatus(milestoneId, status)`** — rare manual override. The spec-side trigger `specs_milestone_rollup` keeps [[../tables/goal_milestones]]`.status` consistent with the attached specs; call this only when the rollup would disagree intentionally (e.g. a director cuts a milestone the rollup can't observe).
- **`attachSpecToMilestone(specId, milestoneId | null)`** — single UPDATE on [[../tables/specs]]`.milestone_id`. The planner calls this when a leaf spec lands; `null` detaches (the explicit standalone-spec shape). The spec-side trigger fires the milestone + goal rollups automatically.

## Status rails — what this lib enforces vs the DB

- **`proposed → greenlit` is CEO-only.** Only `setGoalStatus` writes the flip. The `goal_milestones_rollup` trigger NEVER auto-greenlights a `proposed` goal even if every milestone completes — the rail prevents a still-proposed goal from sneaking past the greenlight gate (see [[../tables/goals]] and the Phase 1 migration).
- **`greenlit → complete` is auto.** When every [[../tables/goal_milestones]] row is `complete`, the trigger flips the goal. Manual `setGoalStatus(goalId, 'complete', actor)` is allowed (rare).
- **`folded` is terminal.** Set by the [[../specs/goal-fold-from-db-row]] fold worker; never overwritten by the rollup or by `upsertGoal` re-runs.
- **Milestone status follows attached specs.** `specs_milestone_rollup` recomputes [[../tables/goal_milestones]]`.status` after every [[../tables/specs]]`.status` or `milestone_id` write. `setMilestoneStatus` is the escape hatch.
- **`parent_goal_id` is acyclic.** Enforced by the `goals_no_cycle` trigger. `upsertGoal` passes `parent_goal_id` through — a cycle attempt raises `SQLSTATE 23514`.

## Callers (future)

- [[../specs/goals-milestones-tables-and-backfill]] Phase 3 — `scripts/backfill-goals-from-markdown.ts` calls `upsertGoal` for every goal markdown file, then `attachSpecToMilestone` for every spec whose `parent` text matches a parsed milestone.
- [[../specs/goal-greenlight-button-and-author-writes-db]] — the CEO greenlight button calls `setGoalStatus(id, 'greenlit', 'ceo')`.
- [[../specs/goal-readers-from-db-retire-parsegoal]] — every goal reader (board, detail, taxonomy, function page, agents-hub CEO profile, decomposition gate, escort, plan-goal skill, goal-decomposition engine, Slack) cuts over from `parseGoal` to `getGoal` / `listGoals` here.
- [[../specs/director-proposed-goals]] (Phase 3) — director-authored goals INSERT a row via `upsertGoal` instead of committing markdown.

## Related

[[specs-table]] · [[brain-roadmap]] · [[../tables/goals]] · [[../tables/goal_milestones]] · [[../tables/specs]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-fold-from-db-row]] · [[../goals/db-driven-specs]]
