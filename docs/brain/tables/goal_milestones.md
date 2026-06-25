# goal_milestones

ONE ROW PER MILESTONE of every goal — `title`, `body`, `position`, and the rolled-up `status`. A child table of [[goals]], keyed by `(goal_id, position)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Why a TABLE, not a jsonb array.** Milestones are a relation specifically so a milestone keeps its stable `id` across reorder/retitle — same lift-a-thing rule as [[spec_phases]]. The [[specs]]`.milestone_id` FK points at this `id`; a jsonb-style destroy+recreate would silently unattach specs (the FK is `on delete set null`). UPSERT-by-`(goal_id, position)` preserves `id` even if the title or body changes.

**Workspace-scoped via the parent** (inherited from `goals.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across reorder/retitle |
| `goal_id` | `uuid` | FK → `goals(id)` on delete cascade |
| `position` | `int` | 1-indexed — the ordering surface. Unique per `(goal_id, position)` |
| `title` | `text` | the milestone title (e.g. `M1 — The spec body in the DB`) |
| `body` | `text?` | the markdown block under the `### M{N}` heading (description + sub-bullets) |
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `planned`. **Trigger-maintained** from child [[specs]] rows |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill replaces milestones under the same `goal_id` keyed by position, preserving `id` and any specs attached via [[specs]]`.milestone_id`.

## Trigger — `goal_milestones_rollup`

After insert / update of `status` or `goal_id` / delete on this table, `public.roll_up_goal_status(goal_id)` recomputes the parent `goals.status`. When every milestone for the goal is `complete`, AND the goal is currently `greenlit`, it flips to `complete`. A `proposed` or `folded` goal is left alone (the rail — only the CEO greenlight button moves `proposed → greenlit`).

## Trigger — `specs_milestone_rollup` (on [[specs]])

The spec-side trigger: when a spec's `status` or `milestone_id` changes, `public.roll_up_milestone_status(milestone_id)` recomputes this milestone's `status`. The rule mirrors [[specs]]: if every attached spec is `shipped` or `folded` → `complete`; any `in_progress` → `in_progress`; otherwise `planned`. A milestone with no attached specs is left alone (we don't drag an empty milestone to `complete`).

**Hard rail:** if either trigger is dropped, the milestone or goal status can stick at a state that contradicts its children — the same class as [[../specs/spec-review-agent]]'s "shipped with 1 phase" bug, one tier up.

## Migration

- `supabase/migrations/20260714120000_goals_and_goal_milestones.sql` — initial table + rollup trigger + spec-side rollup trigger · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`
- One-time backfill from markdown ([[../specs/goals-milestones-tables-and-backfill]] Phase 3): `scripts/backfill-goals-from-markdown.ts`

## Related

[[goals]] · [[specs]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]] · [[../goals/db-driven-specs]]
