# goals

The goal card row for every goal — `slug`, `title`, `body`, `outcome`, `success_metric`, `owner`, `proposer_function`, `parent_goal_id` (the nullable self-ref — a **SubGoal is just a goal with a parent**, not a separate table), and the rolled-up `status`. ONE row per `(workspace_id, slug)`. The milestones live in [[goal_milestones]] (one row per milestone, a child table). Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Today** goals are still read from `docs/brain/goals/{slug}.md` by [[../libraries/brain-roadmap]] `parseGoal` / `getGoals`. This table is the secondary copy until [[../specs/goal-readers-from-db-retire-parsegoal]] cuts readers over. The CEO greenlight write surface ([[../specs/goal-greenlight-button-and-author-writes-db]]) and the fold worker ([[../specs/goal-fold-from-db-row]]) are the surfaces that mutate this table on their respective cutovers.

**Workspace-scoped** (mirrors [[specs]]). RLS: any authenticated user reads; service role does all writes. No client-side goal writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 minus any status emoji |
| `body` | `text` | the full goal body — outcome + why + model + target |
| `outcome` | `text?` | the **Outcome:** one-paragraph line broken out as a column for the board summary |
| `success_metric` | `text?` | the **Success metric:** line — the planner's gap-analysis anchor ([[../skills/plan-goal]]) |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform` |
| `proposer_function` | `text?` | the **Proposed-by:** function set by [[../specs/director-proposed-goals]] for director-authored goals. Null for CEO-authored |
| `parent_goal_id` | `uuid?` | NULLABLE self-ref → `goals(id)` on delete cascade. A SubGoal is just a goal with a parent (CEO-locked design contract) |
| `status` | `text` | `proposed ｜ greenlit ｜ complete ｜ folded` · CHECK-constrained · default `proposed` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`goals_ws_slug` — a **unique index** on `(workspace_id, slug)`. Every backfill / writer goes through this `onConflict` key.

## Rolled-up status

`goals.status` is maintained by `goal_milestones_rollup` (a row-level trigger on [[goal_milestones]]) calling `public.roll_up_goal_status(goal_id)`. Same rule [[../libraries/brain-roadmap]] `deriveGoalStatus` enforces today, but DB-enforced here:

- `proposed` and `folded` are **terminal-ish**: the rollup NEVER overwrites them. The CEO greenlight write surface ([[../specs/goal-greenlight-button-and-author-writes-db]]) is the only path out of `proposed`; the fold worker the only path into `folded`. **Hard rail:** a `proposed` goal whose milestones are all complete stays `proposed` — it never auto-greenlights itself.
- Otherwise: every milestone `complete` → `complete`. Any non-`complete` sibling → `greenlit`.

## Cycle protection on `parent_goal_id`

The design contract allows re-parenting at any time (a goal CAN be reassigned under another goal). Trigger `goals_parent_cycle` (`before insert or update of parent_goal_id`) calls `public.goals_parent_cycle_check()`, which walks the parent chain (bounded at 64 hops) and rejects any UPDATE that would close a loop. A goal cannot be its own ancestor.

## Reads / writes

- **Reader cutover** is [[../specs/goal-readers-from-db-retire-parsegoal]] — until then, `getGoals` / `getGoal` ([[../libraries/brain-roadmap]] L1004+) still read markdown. This table is the secondary copy.
- **Greenlight writes** land here once [[../specs/goal-greenlight-button-and-author-writes-db]] cuts over — `proposed → greenlit` is the CEO action.
- **Fold writes** land here once [[../specs/goal-fold-from-db-row]] cuts over — `greenlit → folded` for archived goals.
- **One-time backfill** from markdown lives in [[../specs/goals-milestones-tables-and-backfill]] Phase 3 → [[../recipes/backfill-goals-from-markdown]].

## Migration

- `supabase/migrations/20260726120000_goals_and_goal_milestones.sql` — initial tables + rollup functions + cycle-protection trigger · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`

## Related

[[goal_milestones]] · [[specs]] · [[spec_phases]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/goal-fold-from-db-row]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../goals/db-driven-specs]]
