# goals

The card row for every goal — `title`, `body`, the one-paragraph `outcome`, `success_metric`, `owner` (DRI function), the optional `proposer_function` (director-proposed), the nullable `parent_goal_id` self-ref (a **SubGoal is just a goal with a parent**), and the rolled-up `status`. ONE row per `(workspace_id, slug)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Today** the goal body is still parsed from `docs/brain/goals/{slug}.md` by [[../libraries/brain-roadmap]] `parseGoal`. This table holds the BODY — once [[../specs/goal-readers-from-db-retire-parsegoal]] flips the readers the markdown is no longer authoritative; until then this is the secondary copy that the reader cutover will lean on.

**Workspace-scoped** (mirrors [[specs]]). RLS: any authenticated user reads; service role does all writes (the writers hold the creds). No client-side goal writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 minus any decorations |
| `body` | `text` | the full goal markdown body (outcome + why + model + target prose) |
| `outcome` | `text?` | the one-paragraph **Outcome:** line — a separate column for the board summary |
| `success_metric` | `text?` | the **Success metric:** line — the planner's gap-analysis anchor ([[../skills/plan-goal]]) |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform`. Free-text for now (no hard FK) |
| `proposer_function` | `text?` | the **Proposed-by:** function ([[../specs/director-proposed-goals]]). Null for a CEO-authored goal |
| `parent_goal_id` | `uuid?` | nullable self-ref — a SubGoal is just a goal with a parent (CEO-locked design contract). Acyclic (trigger-enforced) |
| `status` | `text` | rolled-up lifecycle — `proposed ｜ greenlit ｜ complete ｜ folded`. CHECK-constrained. **Trigger-maintained**: only auto-flips `greenlit → complete` when every milestone is `complete`; never auto-greenlights a `proposed` goal |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`goals_ws_slug` — a **unique index** on `(workspace_id, slug)`. The backfill and every future writer go through this `onConflict` key (insert on first write, update on repeat).

## Indexes

- `goals_ws_slug` — unique on `(workspace_id, slug)` (upsert spine)
- `goals_parent_idx` — partial on `(parent_goal_id) WHERE parent_goal_id IS NOT NULL` (the board's nested-goal render: CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5 ▸ specs ▸ phases)
- `goals_ws_status_idx` — on `(workspace_id, status)` (board filter)

## Triggers

- `goals_no_cycle` — `BEFORE INSERT OR UPDATE OF parent_goal_id`. Walks the parent chain (bounded at 32 hops) and rejects an UPDATE that would close a loop. The design contract allows reassignment ("a goal CAN be (re)assigned under another goal at any time") so the move is one UPDATE, but a cycle is rejected at the rail.

## Rolled-up status

`goals.status` is maintained by `goal_milestones_rollup` on [[goal_milestones]] — when every milestone for the goal is `complete`, the trigger flips `goals.status` from `greenlit` → `complete`. The rollup NEVER auto-flips `proposed → greenlit` — that's the CEO-only [[../specs/goal-greenlight-button-and-author-writes-db]] surface (a rail; otherwise a hand-completed proposed goal would sneak past the greenlight gate). `folded` is terminal-ish — the rollup never overwrites it.

## Migration

- `supabase/migrations/20260714120000_goals_and_goal_milestones.sql` — initial tables + rollup + acyclicity triggers + the FK constraint on [[specs]]`.milestone_id` · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts`

## Related

[[goal_milestones]] · [[specs]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-fold-from-db-row]] · [[../goals/db-driven-specs]]
