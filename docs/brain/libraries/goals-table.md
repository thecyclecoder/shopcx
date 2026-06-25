# libraries/goals-table

The read/write surface for the DB-resident goal hierarchy — [[../tables/goals]] (the goal row) + [[../tables/goal_milestones]] (the per-milestone rows). Authored by [[../specs/goals-milestones-tables-and-backfill]] Phase 2; parallel to [[brain-roadmap]] `getGoals` / `getGoal` (markdown-backed) until [[../specs/goal-readers-from-db-retire-parsegoal]] retires the parser.

**File:** `src/lib/goals-table.ts`

## Why this exists

[[../specs/goals-milestones-tables-and-backfill]] adds the relations [[../tables/goals]] + [[../tables/goal_milestones]] so the top two tiers of the [[../project-management|Goal → Milestone → Spec → Phase]] hierarchy are queryable in the DB (and so the CEO greenlight is a typed write, not a markdown edit + Vercel deploy — [[../specs/goal-greenlight-button-and-author-writes-db]]). This module is the canonical writer + read surface those rows are managed through. NO reader has been retargeted yet — `getGoals` / `getGoal` ([[brain-roadmap|L1004]]) still parse `docs/brain/goals/*.md`; the [[../recipes/backfill-goals-from-markdown]] one-time backfill seeds the rows so the cutover ([[../specs/goal-readers-from-db-retire-parsegoal]]) can lean on them.

## Types

- **`GoalRowStatus`** = `'proposed' ｜ 'greenlit' ｜ 'complete' ｜ 'folded'` — the `goals.status` enum (CHECK-constrained in the migration). `folded` is added here (the existing [[brain-roadmap]] `GoalStatus` type stays narrower until [[../specs/goal-readers-from-db-retire-parsegoal]] retires it).
- **`MilestoneRowStatus`** = `'planned' ｜ 'in_progress' ｜ 'complete'` — the `goal_milestones.status` enum.
- **`GoalRow`** — `{ id, workspace_id, slug, title, body, outcome, success_metric, owner, proposer_function, parent_goal_id, status, created_at, updated_at, milestones: GoalMilestoneRow[] }`.
- **`GoalMilestoneRow`** — `{ id, goal_id, position, title, body, status, created_at, updated_at }`. `position` is 1-indexed; `id` is STABLE across reorders.
- **`GoalRowInput`** / **`GoalMilestoneInput`** — the writable field sets `upsertGoal` accepts.

## Exports

- **`getGoal(workspaceId, slug)`** → `GoalRow | null` — the parent row + its ordered milestones.
- **`listGoals(workspaceId, filter?)`** → `GoalRow[]` — filterable by `{ status, owner, parent_goal_id }` (pass `parent_goal_id: null` for top-level goals, a uuid for subgoals of one parent).
- **`upsertGoal(workspaceId, row, milestones)`** → `{ goal_id, milestone_ids }` — UPSERT by `(workspace_id, slug)` + REPLACE milestones under the same `goal_id`:
  - matching `(goal_id, position)` rows are UPDATED in place — **preserving the stable `id`** so [[../tables/specs]] `milestone_id` FKs survive a reorder / retitle
  - new positions INSERT
  - vanished positions DELETE
  - the rollup triggers keep `goals.status` + `goal_milestones.status` consistent after every write
- **`setGoalStatus(goalId, status, actor)`** — the explicit status write surface, the CEO-greenlight entry point for [[../specs/goal-greenlight-button-and-author-writes-db]]. The DB CHECK enforces the enum; the rollup handles eventual `greenlit → complete` once every milestone lands. Use this for explicit flips: `proposed → greenlit` (CEO), `* → folded` (fold worker). `actor` is recorded on `updated_at` only — the audit-grade trail lives in a future history table.
- **`setMilestoneStatus(milestoneId, status)`** — rare; the trigger usually keeps a milestone in sync with its child specs. Exposed for manual overrides (e.g. flipping back to `planned` after lifting every spec).
- **`attachSpecToMilestone(specId, milestoneId)`** — a single `UPDATE specs SET milestone_id=…`. The `specs_milestone_rollup` trigger rolls up both the new and old milestone. Pass `null` to detach (a standalone spec).

All writers route through `createAdminClient()` (service-role; the RLS policies `goals_service` / `goal_milestones_service` grant full access). No client-side writes.

## The CEO-greenlight rail

`goals.status` ROLLS UP via the `goal_milestones_rollup` trigger BUT a **proposed** or **folded** goal is terminal-ish for the rollup — it never auto-flips. A `proposed` goal can ONLY become `greenlit` via an explicit `setGoalStatus(id, 'greenlit', actor)` write (the CEO's call in [[../specs/goal-greenlight-button-and-author-writes-db]]). The rollup then takes over and ships the goal to `complete` once every milestone is complete. This guards the [[../goals/db-driven-specs]] outcome — "the CEO literally had no surface to approve the goal" — at the DB rail rather than in app code.

## Parent cycle protection

`parent_goal_id` is acyclic. The `goals_parent_cycle` BEFORE trigger walks the parent chain on every INSERT/UPDATE of `parent_goal_id` and rejects any move that closes a loop. A subgoal is just a goal with a parent (per the CEO-locked design contract) — reassignment is one `UPDATE goals SET parent_goal_id=…`; the rail rejects the bad ones.

## Not atomic across parent + children

supabase-js has no transaction surface, so `upsertGoal` is a sequence (UPSERT goals, then DELETE / UPDATE / INSERT goal_milestones). The rollup triggers keep statuses consistent after each write, and re-running the same call is idempotent (position-keyed REPLACE is deterministic). Callers requiring true atomicity must compose at the SQL layer.

## Callers

- **[[../recipes/backfill-goals-from-markdown]]** (`scripts/backfill-goals-from-markdown.ts`) — runs [[brain-roadmap]] `parseGoal` ONE LAST TIME over `docs/brain/goals/*.md` and upserts the rows.
- **`/api/roadmap/goal/greenlight` · `/ungreenlight` · `/decline`** ([[../specs/goal-greenlight-button-and-author-writes-db]] Phase 1) — the CEO's one-click DB-flag routes. `greenlight` flips `proposed → greenlit` via `setGoalStatus`, `ungreenlight` reverses (while `goal_milestones.status` is all `planned`), and `decline` flips `proposed → folded`. Each is CEO-only (gated on `workspace_members.role='owner'`) and writes one [[../tables/director_activity]] row (`greenlit_goal` / `ungreenlit_goal` / `declined_goal`) for audit.
- **`<GreenlightButton>`** (`src/app/dashboard/roadmap/goals/GreenlightButton.tsx`) — the client component on the goal card list + detail page that posts to those routes. Hides itself for non-owner viewers; the route enforces CEO-only server-side too.
- **[[../specs/goal-readers-from-db-retire-parsegoal]]** — the future cutover that swaps `getGoals` / `getGoal` ([[brain-roadmap|L1004]]) to read FROM here instead of markdown.

## Gotchas

- **The proposed-goal rail.** `setGoalStatus(id, 'complete', ...)` on a `proposed` goal is allowed by the CHECK but the rollup will never get there on its own — that's deliberate: the CEO has to greenlight first ([[../specs/goal-greenlight-button-and-author-writes-db]]).
- **`upsertGoal` preserves milestone ids.** Matching `(goal_id, position)` rows are UPDATED, not replaced — so a [[../tables/specs]] `milestone_id` FK pointing at a milestone survives a retitle. A destroy+recreate would silently unattach every child spec (the FK is `on delete set null`).
- **A subgoal is just a goal with `parent_goal_id`.** Not a separate table — the CEO-locked design contract. Reassignment is one UPDATE; cycles rejected at the rail.

## Related

[[../tables/goals]] · [[../tables/goal_milestones]] · [[../tables/specs]] · [[brain-roadmap]] · [[specs-table]] · [[../recipes/backfill-goals-from-markdown]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../goals/db-driven-specs]]
