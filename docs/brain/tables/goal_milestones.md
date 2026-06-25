# goal_milestones

ONE ROW PER milestone of every goal — `title`, `body`, the rolled-up `status`, and `position` (1-indexed). A child table of [[goals]], keyed by `(goal_id, position)`. Authored by [[../specs/goals-milestones-tables-and-backfill]] (M5 of [[../goals/db-driven-specs]]).

**Why a TABLE, not a jsonb array on `goals`.** Milestones are a relation specifically so a milestone keeps its STABLE `id` across reorder/retitle — and so `specs.milestone_id` FK rows pointing at the milestone stay intact through a milestone shuffle. A jsonb-style destroy+recreate would silently unattach every spec via the `on delete set null` FK (see [[specs]] § `milestone_id`).

**Workspace-scoped via the parent** (inherited from `goals.workspace_id`). RLS: authenticated reads; service-role full access. No client-side writes.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` — STABLE across reorders/retitles |
| `goal_id` | `uuid` | FK → `goals(id)` on delete cascade |
| `position` | `int` | 1-indexed milestone position — the ordering surface. Unique per `(goal_id, position)` |
| `title` | `text` | e.g. `M1 — The spec body in the DB` |
| `body` | `text?` | the markdown block under the `### M{N}` heading — bullets + prose |
| `status` | `text` | `planned ｜ in_progress ｜ complete` · CHECK-constrained · default `planned` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Upsert spine

`goal_milestones_goal_position` — a **unique index** on `(goal_id, position)`. The backfill replaces milestones under the same `goal_id` keyed by position; reorder/retitle is an UPSERT that preserves `id`.

## Trigger — `specs_milestone_rollup` (on `public.specs`)

After insert / update of `status` or `milestone_id` / delete on [[specs]], `public.roll_up_milestone_status(milestone_id)` recomputes this row's `status`:

- Every child spec `shipped` or `folded` → `complete`
- Any child `in_progress` (or partial-shipped) → `in_progress`
- Otherwise → `planned`

A spec moving milestones fires the rollup on BOTH sides (old + new). **Hard rail:** a milestone cannot be `complete` while any child spec is non-shipped — the rollup is the only writer.

## Trigger — `goal_milestones_rollup` (on this table)

After insert / update of `status` or `goal_id` / delete on this table, `public.roll_up_goal_status(goal_id)` recomputes the parent goal's `status`. See [[goals]] § Rolled-up status — `proposed` and `folded` are terminal-ish, so a still-`proposed` goal stays `proposed` even when every milestone is `complete`.

## Provenance preservation

A milestone shuffle in the parsed source UPSERTs by `(goal_id, position)` preserving `id`. Specs already pointing at `goal_milestones.id` via [[specs]] `milestone_id` keep that FK valid through the shuffle. A destroy+recreate would `on delete set null` every attached spec — DO NOT.

## Migration

- `supabase/migrations/20260726120000_goals_and_goal_milestones.sql` — initial table + rollup function + trigger · apply: `scripts/apply-goals-tables-migration.ts` · verify: `scripts/_verify-goals-schema.ts`

## Related

[[goals]] · [[specs]] · [[spec_phases]] · [[../libraries/goals-table]] · [[../libraries/brain-roadmap]] · [[../specs/goals-milestones-tables-and-backfill]]
