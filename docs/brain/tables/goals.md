# goals

The goal card for every entry in `docs/brain/goals/*.md` — `slug`, `title`, `body`, `outcome`, `success_metric`, `owner`, `proposer_function`, `parent_goal_id` (self-ref nullable — a **SubGoal is just a goal with a parent**, per the CEO-locked design contract), and the rolled-up `status`. ONE row per `(workspace_id, slug)`. The milestone list lives in [[goal_milestones]] (one row per milestone, a child table). Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Today** goals are still parsed from `docs/brain/goals/{slug}.md` by [[../libraries/brain-roadmap]] `parseGoal` (L868) and `getGoals` (L1004). This table holds the row for the cutover — [[../specs/goal-readers-from-db-retire-parsegoal]] flips readers off the markdown parse; until then the `.md` files stay authoritative.

**Workspace-scoped** (mirrors [[specs]]). RLS: any authenticated user reads; service role does all writes (the writers hold the creds). No client-side goal writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `slug` | `text` | `docs/brain/goals/{slug}.md` key — the upsert spine |
| `title` | `text` | the H1 minus any status emoji |
| `body` | `text` | full goal body — outcome + why + model + target (the milestone block lives in [[goal_milestones]]) |
| `outcome` | `text?` | the **Outcome:** paragraph as a separate column for the board summary |
| `success_metric` | `text?` | the **Success metric:** line — the [[../skills/plan-goal]] gap-analysis anchor |
| `owner` | `text` | function slug (DRI) — `growth ｜ cmo ｜ retention ｜ cfo ｜ logistics ｜ cs ｜ platform`. Free-text for now (no hard FK) |
| `proposer_function` | `text?` | the **Proposed-by:** function — set by [[../specs/director-proposed-goals]]; null for CEO-authored goals |
| `parent_goal_id` | `uuid?` | self-ref → `goals(id)` on delete cascade. NULLABLE. A SubGoal is just a goal with a parent (CEO-locked design contract). Cycle-protected by `goals_parent_cycle_check` (trigger walks the chain; depth 64 cap) |
| `status` | `text` | rolled-up overall status — `proposed ｜ greenlit ｜ complete ｜ folded`. CHECK-constrained. **Trigger-maintained** by `goal_milestones_rollup`, with one rail: the rollup NEVER auto-flips `proposed → greenlit` — only the CEO action in [[../specs/goal-greenlight-button-and-author-writes-db]] does that |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`goals_ws_slug` — a **unique index** on `(workspace_id, slug)`. The backfill ([[../recipes/backfill-goals-from-markdown]]) and every future writer go through this `onConflict` key.

## Indexes

- `goals_ws_slug` — `(workspace_id, slug)` unique · upsert key
- `goals_parent_idx` — `(parent_goal_id) where parent_goal_id is not null` · powers the board's nested-goal render (CEO Mode ▸ Fully Autonomous CTO ▸ M1…M5 ▸ specs ▸ phases)
- `goals_ws_status_idx` — `(workspace_id, status)` · the proposed/greenlit/complete filters

## Rolled-up status

`goals.status` is maintained by a row-level trigger (`goal_milestones_rollup`) on [[goal_milestones]] — it calls `public.roll_up_goal_status(goal_id)`. The rule:

- `folded` is **terminal-ish** — the rollup never overwrites it (the fold worker moves goals out of `folded` explicitly).
- `proposed` is **never auto-flipped** — only [[../specs/goal-greenlight-button-and-author-writes-db]] flips a goal from `proposed` to `greenlit`. The rollup leaves a `proposed` goal at `proposed` even if every milestone is `complete`. This is the rail: a goal cannot silently complete without ever being greenlit.
- `greenlit → complete` is the **one automatic flip** — the rollup makes it when every child `goal_milestones` row is `complete`.
- `complete → greenlit` is the inverse — if a previously-complete goal grows a new not-complete milestone, the rollup walks it back.

## Parent cycle protection

`goals_parent_cycle_check` (BEFORE INSERT OR UPDATE OF `parent_goal_id`) walks the parent chain and raises if the new `parent_goal_id` would close a loop (including the trivial self-parent case). Chain depth is capped at 64 — a sane upper bound for "Goal → SubGoal → SubSubGoal …" before something is structurally wrong.

The design contract allows reassigning a goal under another at any time (a single UPDATE), so the move is cheap — but a cycle is rejected at the rail.

## Reads / writes

- **Reader cutover is owned by [[../specs/goal-readers-from-db-retire-parsegoal]]** — until then, `getGoals` / `getGoal` ([[../libraries/brain-roadmap]] L1004+) still read markdown. This table is the secondary copy.
- **Writer cutover** — the future [[../libraries/goals-table]] is the canonical write surface (`upsertGoal`, `setGoalStatus`, `setMilestoneStatus`, `attachSpecToMilestone`); today the backfill is the only writer.
- M5 ([[../specs/goals-milestones-tables-and-backfill]]) creates the relations + the one-time backfill from `docs/brain/goals/*.md`.

## Migration

- `supabase/migrations/20260726120000_goals_and_goal_milestones.sql` — initial tables + FK constraint + cycle trigger + rollup triggers · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts`

## Related

[[goal_milestones]] · [[specs]] · [[../libraries/brain-roadmap]] · [[../libraries/goals-table]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/goal-readers-from-db-retire-parsegoal]] · [[../specs/goal-greenlight-button-and-author-writes-db]] · [[../specs/director-proposed-goals]] · [[../goals/db-driven-specs]]
