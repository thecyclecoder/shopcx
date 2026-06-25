# libraries/goals-table

The canonical read/write surface for the DB-resident goal hierarchy — [[../tables/goals]] (the goal row) + [[../tables/goal_milestones]] (the per-milestone rows). The `getGoals` / `getGoal` readers in [[brain-roadmap]] have been switched over to read from this surface ([[../specs/goal-readers-from-db-retire-parsegoal]] Phase 2). Authored by [[../specs/goals-milestones-tables-and-backfill]] Phase 2.

**File:** `src/lib/goals-table.ts`

## Why this exists

[[../specs/goals-milestones-tables-and-backfill]] adds the relations [[../tables/goals]] + [[../tables/goal_milestones]] so the top two tiers of the [[../project-management|Goal → Milestone → Spec → Phase]] hierarchy are queryable in the DB (and so the CEO greenlight is a typed write, not a markdown edit + Vercel deploy — [[../specs/goal-greenlight-button-and-author-writes-db]]). This module is the canonical writer + read surface those rows are managed through. The readers ([[brain-roadmap]] `getGoals` / `getGoal`) have been switched over ([[../specs/goal-readers-from-db-retire-parsegoal]] Phase 2) and now read from these rows; the legacy `parseGoal` markdown parser has been retired (Phase 3).

## Types

- **`GoalRowStatus`** = `'proposed' ｜ 'greenlit' ｜ 'complete' ｜ 'folded'` — the `goals.status` enum (CHECK-constrained in the migration). `folded` is added here (the existing [[brain-roadmap]] `GoalStatus` type stays narrower until [[../specs/goal-readers-from-db-retire-parsegoal]] retires it). The column holds the greenlight INPUT; `complete` is derived by the reader.
- **`GoalRow`** — `{ id, workspace_id, slug, title, body, outcome, success_metric, owner, proposer_function, parent_goal_id, status, created_at, updated_at, milestones: GoalMilestoneRow[] }`.
- **`GoalMilestoneRow`** — `{ id, goal_id, position, title, body, created_at, updated_at }`. No `status` field — milestone completion is DERIVED from child specs by the readers (`goal_milestones.status` was dropped in `derive-rollup-status` P3). `position` is 1-indexed; `id` is STABLE across reorders.
- **`GoalRowInput`** / **`GoalMilestoneInput`** — the writable field sets `upsertGoal` accepts.

## Exports

- **`getGoal(workspaceId, slug)`** → `GoalRow | null` — the parent row + its ordered milestones.
- **`listGoals(workspaceId, filter?)`** → `GoalRow[]` — filterable by `{ status, owner, parent_goal_id }` (pass `parent_goal_id: null` for top-level goals, a uuid for subgoals of one parent).
- **`upsertGoal(workspaceId, row, milestones)`** → `{ goal_id, milestone_ids }` — UPSERT by `(workspace_id, slug)` + REPLACE milestones under the same `goal_id`:
  - matching `(goal_id, position)` rows are UPDATED in place — **preserving the stable `id`** so [[../tables/specs]] `milestone_id` FKs survive a reorder / retitle
  - new positions INSERT
  - vanished positions DELETE
  - the writer only persists STRUCTURE (titles, bodies, positions); milestone + goal completion is derived by the readers, so nothing rolls up on the write
- **`setGoalStatus(goalId, status, actor)`** — the explicit status write surface, the CEO-greenlight entry point for [[../specs/goal-greenlight-button-and-author-writes-db]]. The DB CHECK enforces the enum. Use this for explicit flips: `proposed → greenlit` (CEO), `* → folded` (fold worker). `complete` is DERIVED by the reader, not written here. `actor` is recorded on `updated_at` only — the audit-grade trail lives in a future history table.
- **`attachSpecToMilestone(specId, milestoneId)`** — a single `UPDATE specs SET milestone_id=…`. Milestone completion is derived from its linked specs at read time, so no rollup fires. Pass `null` to detach (a standalone spec).

All writers route through `createAdminClient()` (service-role; the RLS policies `goals_service` / `goal_milestones_service` grant full access). No client-side writes.

## The CEO-greenlight rail

`goals.status` holds the greenlight INPUT (`proposed` / `greenlit` / `folded`); the `complete` state is DERIVED by the reader ([[brain-roadmap]] `goalRowToCard`) — there is no rollup trigger anymore. A `proposed` goal can ONLY become `greenlit` via an explicit `setGoalStatus(id, 'greenlit', actor)` write (the CEO's call in [[../specs/goal-greenlight-button-and-author-writes-db]]); the reader then surfaces a `greenlit` goal as `complete` once every milestone is complete (each linked-spec completion ≥ 1), but a `proposed` goal NEVER surfaces complete. This guards the [[../goals/db-driven-specs]] outcome — "the CEO literally had no surface to approve the goal" — at the read rail.

## Parent cycle protection

`parent_goal_id` is acyclic. The `goals_parent_cycle` BEFORE trigger walks the parent chain on every INSERT/UPDATE of `parent_goal_id` and rejects any move that closes a loop. A subgoal is just a goal with a parent (per the CEO-locked design contract) — reassignment is one `UPDATE goals SET parent_goal_id=…`; the rail rejects the bad ones.

## Not atomic across parent + children

supabase-js has no transaction surface, so `upsertGoal` is a sequence (UPSERT goals, then DELETE / UPDATE / INSERT goal_milestones). It writes only structure; completion is derived at read time, so there's no rollup to keep consistent — and re-running the same call is idempotent (position-keyed REPLACE is deterministic). Callers requiring true atomicity must compose at the SQL layer.

## Callers

- **[[../recipes/backfill-goals-from-markdown]]** (`scripts/backfill-goals-from-markdown.ts`) — ran the legacy [[brain-roadmap]] `parseGoal` once over `docs/brain/goals/*.md` and upserted the rows (backfill complete).
- **`/api/roadmap/goal/greenlight` · `/ungreenlight` · `/decline`** ([[../specs/goal-greenlight-button-and-author-writes-db]] Phase 1) — the CEO's one-click DB-flag routes. `greenlight` flips `proposed → greenlit` via `setGoalStatus`, `ungreenlight` reverses (refusing once any milestone has DERIVED progress — read off the `getGoals` GoalCard, no `goal_milestones.status` column anymore), and `decline` flips `proposed → folded`. Each is CEO-only (gated on `workspace_members.role='owner'`) and writes one [[../tables/director_activity]] row (`greenlit_goal` / `ungreenlit_goal` / `declined_goal`) for audit.
- **`<GreenlightButton>`** (`src/app/dashboard/roadmap/goals/GreenlightButton.tsx`) — the client component on the goal card list + detail page that posts to those routes. Hides itself for non-owner viewers; the route enforces CEO-only server-side too.
- **[[../specs/goal-readers-from-db-retire-parsegoal]]** (Phase 2) — completed cutover. `getGoals` / `getGoal` ([[brain-roadmap]]) now read FROM these tables instead of markdown.

## Gotchas

- **The proposed-goal rail.** `setGoalStatus(id, 'complete', ...)` on a `proposed` goal is allowed by the CHECK but the reader never DERIVES `complete` for a non-greenlit goal — that's deliberate: the CEO has to greenlight first ([[../specs/goal-greenlight-button-and-author-writes-db]]).
- **`upsertGoal` preserves milestone ids.** Matching `(goal_id, position)` rows are UPDATED, not replaced — so a [[../tables/specs]] `milestone_id` FK pointing at a milestone survives a retitle. A destroy+recreate would silently unattach every child spec (the FK is `on delete set null`).
- **A subgoal is just a goal with `parent_goal_id`.** Not a separate table — the CEO-locked design contract. Reassignment is one UPDATE; cycles rejected at the rail.

## Related

[[../tables/goals]] · [[../tables/goal_milestones]] · [[../tables/specs]] · [[brain-roadmap]] · [[specs-table]] · [[../recipes/backfill-goals-from-markdown]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../goals/db-driven-specs]]
