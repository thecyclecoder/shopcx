# goal_milestones

The middle tier of the [[../project-management|Goal → Milestone → Spec → Phase]] hierarchy. ONE ROW PER milestone under a parent [[goals]] row. The decomposition surface — a [[../specs/director-proposed-goals]] proposal or a CEO-authored goal lists its M1…MN milestones here, each a discrete deliverable a planner ([[../skills/plan-goal]]) can decompose into specs.

**Workspace-scoped** (via the parent `goals.workspace_id`). RLS: any authenticated workspace user reads; service role does all writes (mirrors [[goals]] / [[spec_card_state]]).

**Primary key:** `id` — STABLE across reorders (same lift-a-thing rule as `spec_phases`). A milestone can be re-positioned without losing the `public.specs.milestone_id` FKs pointing at it. Destroy+recreate would silently unattach specs (the FK is `on delete set null`).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` · STABLE across position/title edits |
| `goal_id` | `uuid` | FK → [[goals]]`(id)` on delete cascade |
| `position` | `int` | 1-indexed display order. Unique per `goal_id`. |
| `title` | `text` | e.g. `"M1 — The spec body in the DB"` |
| `body` | `text?` | the milestone description + sub-bullets the goal markdown's `### M{N}` block carries |
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `'planned'` · **rolled up from child specs** (see below) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write (trigger) |

## Upsert spine

`goal_milestones_goal_position` — **unique index** on `(goal_id, position)`. The [[../recipes/backfill-goals-from-markdown]] REPLACEs milestones under a goal preserving `id` by `position` — so re-running the backfill after a renumbering edit keeps stable ids.

## Status rollup

`status` ROLLS UP from `public.specs.status` via the `roll_up_milestone_status(milestone_id)` SQL function. The rule (mirrors [[../libraries/brain-roadmap]] `deriveStatus`):

- Any child spec `in_progress` → `in_progress`.
- All child specs `shipped` OR `folded` → `complete`.
- Otherwise (or no children) → `planned`.

A milestone reaching `complete` fires the `goal_milestones_rollup_to_goal` trigger which calls `roll_up_goal_status(goal_id)` on the parent — flipping the goal to `complete` only when ALL siblings are `complete` AND the goal is currently `greenlit` (a `proposed` goal NEVER auto-completes — the explicit rail).

**Status / open work — deferred trigger.** The trigger on `public.specs` (after update of `status` or `milestone_id`) that CALLS `roll_up_milestone_status` is deferred until [[../specs/spec-body-table-and-backfill]] ships the `public.specs` table. Until then, the function exists (callable directly) but no automatic invocation fires — milestone status moves only when a writer calls the function explicitly. The follow-up migration adds the trigger + the `public.specs.milestone_id` FK constraint in one short SQL file.

## Writers

Authored by [[../specs/goals-milestones-tables-and-backfill]]. The writer surface ships in Phase 2 (the [[../libraries/goals-table]] lib — `setMilestoneStatus`, `attachSpecToMilestone`, etc.); the backfill from `docs/brain/goals/*.md` ships in Phase 3 ([[../recipes/backfill-goals-from-markdown]]).

The board's milestone view (a follow-up surface in [[../specs/goal-readers-from-db-retire-parsegoal]]) joins `specs` → `goal_milestones` → `goals` via the FK chain.

## Migration

- `supabase/migrations/20260725120000_goals_and_goal_milestones.sql` — initial table + the parent [[goals]] + rollup functions/triggers. Apply: `scripts/apply-goals-tables-migration.ts`. Verify: `scripts/_verify-goals-schema.ts`.

## Related

[[goals]] · [[../libraries/goals-table]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../specs/spec-body-table-and-backfill]] (the blocker — once shipped, the `public.specs.milestone_id` FK + trigger land in a follow-up) · [[../specs/goal-readers-from-db-retire-parsegoal]]
