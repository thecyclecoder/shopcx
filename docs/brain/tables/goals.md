# goals

The goal row for every entry in [[../goals/]] — the top tier of the [[../project-management|Goal → Milestone → Spec → Phase]] hierarchy as data. ONE row per `(workspace_id, slug)`. Milestones live in [[goal_milestones]] (one row per `### M{N} —` sub-section, a child table). Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**A SubGoal is just a goal with a `parent_goal_id`.** Not a separate table — the CEO-locked design contract is explicit: subgoals are reassignable ("a goal CAN be (re)assigned under another goal at any time") via one `UPDATE goals SET parent_goal_id=…`. Cycles are rejected at the rail (the `goals_parent_cycle` trigger walks the chain on every write).

Goals are now read from this table by [[../libraries/brain-roadmap]] `getGoals` / `getGoal` ([[../specs/goal-readers-from-db-retire-parsegoal]] Phase 2). The backfill ([[../recipes/backfill-goals-from-markdown]]) seeded rows from `docs/brain/goals/{slug}.md` via the legacy `parseGoal` parser, which is now retired ([[../specs/goal-readers-from-db-retire-parsegoal]] Phase 3).

**Workspace-scoped** (mirrors [[specs]] / [[spec_card_state]]). RLS: any authenticated user reads; service role does all writes (the writers hold the creds). No client-side goal writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 minus any status emoji |
| `body` | `text` | the full goal body — Outcome + Why + Model + Target + Decomposition |
| `outcome` | `text?` | the one-paragraph **Outcome:** line — pulled out for the board summary |
| `success_metric` | `text?` | the **Success metric:** line — the planner's gap-analysis anchor ([[../skills/plan-goal]]) |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform` (free-text for now) |
| `proposer_function` | `text?` | the **Proposed-by:** function — set by [[../specs/director-proposed-goals]] when a director authored the goal; null for CEO-authored goals |
| `parent_goal_id` | `uuid?` | self-ref → `goals(id)` on delete cascade. **NULLABLE** — a SubGoal is just a goal with a parent (CEO-locked design contract) |
| `status` | `text` | `proposed ｜ greenlit ｜ complete ｜ folded` · CHECK-constrained · default `proposed`. Holds the CEO-greenlight INPUT (`proposed → greenlit` is the CEO-only path, [[../specs/goal-greenlight-button-and-author-writes-db]]; `* → folded` is the fold worker). `complete` is DERIVED by the reader — see Derived status |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`goals_ws_slug` — a **unique index** on `(workspace_id, slug)`. The backfill ([[../recipes/backfill-goals-from-markdown]]) and every future writer go through this `onConflict` key.

## Indexes

- `goals_ws_slug` — unique `(workspace_id, slug)` (the upsert spine).
- `goals_parent_idx` — `parent_goal_id` (partial: `where parent_goal_id is not null`). The board's nested-goal render joins on this.
- `goals_ws_status_idx` — `(workspace_id, status)`. The Roadmap filters by status.

## Derived status

`goals.status` is no longer trigger-maintained — the `goal_milestones_rollup` trigger + `roll_up_goal_status` were dropped in `derive-rollup-status` P3 (migration `20260725160000`). The stored column holds only the explicit greenlight INPUT (`proposed` / `greenlit` / `folded`); the `complete` state is DERIVED by [[../libraries/brain-roadmap]] `goalRowToCard`:

- **A proposed goal NEVER surfaces as `complete`** — the proposed → greenlit step is the CEO-only path ([[../specs/goal-greenlight-button-and-author-writes-db]]); a non-greenlit goal completing would be a rail break, so the deriver only flips a `greenlit` goal.
- A `greenlit` goal whose milestones ALL roll up complete (each linked-spec completion ≥ 1) → surfaced as `complete`.
- Otherwise the stored status (`proposed` / `greenlit`). A goal with zero milestones is never `complete`.

## Parent cycle protection

`goals_parent_cycle` (BEFORE INSERT/UPDATE OF `parent_goal_id, id`) calls `public.goals_parent_cycle_guard()` — walks the parent chain on every write and rejects any move that closes a loop (`id = ancestor.id`). The chain walker bails after 64 hops as a backstop against runaway state.

## Reads / writes

- **Reader cutover** [[../specs/goal-readers-from-db-retire-parsegoal]] (Phase 2) — completed. `getGoals` / `getGoal` ([[../libraries/brain-roadmap]]) now read this table. The markdown files `docs/brain/goals/*.md` are retained for fold operations ([[../specs/goal-fold-from-db-row]]).
- **Writer surface** is [[../libraries/goals-table]] — `upsertGoal`, `setGoalStatus` (the CEO-greenlight write surface for [[../specs/goal-greenlight-button-and-author-writes-db]]).
- **One-time backfill** from markdown: [[../recipes/backfill-goals-from-markdown]] — runs the EXISTING [[../libraries/brain-roadmap]] `parseGoal` one last time and INSERTs both `goals` + [[goal_milestones]] rows.

## Migration

- `supabase/migrations/20260725130000_goals_and_goal_milestones.sql` — initial tables + rollup function + triggers + parent-cycle guard · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- `supabase/migrations/20260725160000_drop_rollup_triggers_and_milestone_status.sql` — `derive-rollup-status` P3: dropped the rollup triggers + functions (the parent-cycle guard is kept) so `goals.status` is no longer auto-written; `complete` is derived by the reader

## Related

[[goal_milestones]] · [[specs]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/director-proposed-goals]] · [[../goals/db-driven-specs]]
