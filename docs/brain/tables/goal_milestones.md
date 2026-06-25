# goal_milestones

ONE ROW PER MILESTONE of every goal — the milestone title, body, position (1-indexed within its goal), and the rolled-up `status`. A child table of [[goals]], keyed by `(goal_id, position)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Why a TABLE, not a jsonb array.** Same rule as [[spec_phases]]: a milestone's `id` must be STABLE across reorders or retitles so existing `specs.milestone_id` FKs pointing at it survive. A jsonb-style destroy+recreate would silently unattach every child spec (the FK is `on delete set null` — destructive writes drop the link). With a table a retitle / reposition is one `UPDATE goal_milestones SET title=…, position=…` that preserves the id.

**Workspace-scoped via the parent** (inherited from `goals.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across reorders / retitles |
| `goal_id` | `uuid` | FK → `goals(id)` on delete cascade |
| `position` | `int` | 1-indexed within the goal — the ordering surface. Unique per `(goal_id, position)` |
| `title` | `text` | the milestone title (e.g. `M1 — The spec body in the DB`) |
| `body` | `text?` | the markdown block under the `### M{N}` heading — bullets + prose |
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `planned` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill replaces milestones under the same `goal_id` keyed by position; matching positions UPDATE in place preserving `id`, new positions INSERT, vanished positions DELETE — same rule [[../libraries/specs-table]] `upsertSpec` follows for phases.

## Trigger — `specs_milestone_rollup` (incoming) + `goal_milestones_rollup` (outgoing)

**Incoming.** When a row in [[specs]] is inserted / updated (status or milestone_id changes) / deleted, `specs_milestone_rollup` fires and calls `public.roll_up_milestone_status(milestone_id)` on each affected milestone. The rule: every child spec `shipped` or `folded` → `complete`; any `in_progress` → `in_progress`; else `planned`. Standalone specs (`milestone_id=null`) are ignored.

**Outgoing.** When this row's status changes, `goal_milestones_rollup` calls `public.roll_up_goal_status(goal_id)` — which flips `goals.status='greenlit' → 'complete'` only when EVERY milestone is `complete` (and never auto-flips a `proposed` goal — see [[goals]] § Status).

**Hard rail.** If `specs_milestone_rollup` is ever dropped, a milestone could be stuck at `complete` while a child spec is still `in_progress` (the goal-side equivalent of the [[../specs/spec-review-agent]] "shipped with 1 phase" class). If `goal_milestones_rollup` is dropped, a fully-shipped goal stays `greenlit` forever.

## Migration

- `supabase/migrations/20260714120000_goals_and_goal_milestones.sql` — initial table + rollup triggers · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`

## Related

[[goals]] · [[specs]] · [[spec_phases]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../goals/db-driven-specs]] · [[../project-management]]
