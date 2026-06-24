# director_directives

The **executable plan store** for the CEO↔Director chat ([[../specs/director-executable-plans-and-priority]] Phase 1). A **directive** is a plan the CEO hands a director through the chat's third intent `plan`: it re-prioritizes **WHAT** the director does until done — "build X first / gate builds until Y" — without loosening **HOW** (the leash, loop-guard, soundness gate, and escalation rails are unchanged). The director investigates read-only, emits a `directive` approval card, and on the CEO's approval the worker inserts **one active** row here ([[../tables/director_coach_threads]] / `runDirectorCoachJob`).

The standing pass ([[../libraries/platform-director]], Phase 2) loads the **one `active`** directive and runs it **first**, before the routine lanes; the **build-gate** pauses build-enqueue while `gate_builds_until` is unshipped, auto-lifting (and auto-completing the directive) when that spec ships.

**Workspace-scoped** (mirrors [[director_activity]] / [[director_messages]]). RLS: any authenticated user reads (the surfaces are owner-gated above the DB); service role does all writes. On approval the worker also writes a `directive_accepted` [[director_activity]] row.

**Migration:** `supabase/migrations/20260707120000_director_directives.sql` · apply via `npx tsx scripts/apply-director-directives-migration.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `director_function` | `text` | the function slug the directive is **for** (the director who must execute it; e.g. `platform` — Ada) |
| `summary` | `text` | one-line summary of the plan (shown on the chat card + the Agents hub) |
| `steps` | `jsonb` | the ordered plan — a jsonb array of plain-text steps · default `[]` |
| `gate_builds_until` | `text` | optional spec slug: while set + that spec is unshipped, the director **pauses build-enqueue** (the gate); null = no gate |
| `status` | `text` | `active｜done｜cleared` — **open vocabulary, no CHECK**. `done` = the gate's spec shipped; `cleared` = the CEO cleared it (or a newer directive superseded it) |
| `created_by` | `uuid` | FK → `auth.users(id)` — the CEO who approved it |
| `created_at` | `timestamptz` | default `now()` |
| `completed_at` | `timestamptz` | set when `status` leaves `active` |

## Indexes

- `director_directives_one_active_idx` — **partial UNIQUE** on `(workspace_id, director_function) where status = 'active'`. Enforces **at most one active directive per director** (the standing pass loads "the one active"). On a new directive the worker first flips any existing `active` row to `cleared`, then inserts.
- `director_directives_ws_dir_created_idx` on `(workspace_id, director_function, created_at desc)` — the Agents-hub / audit read.

## Related

[[director_activity]] · [[director_coach_threads]] · [[../libraries/platform-director]] · [[../specs/director-executable-plans-and-priority]] · [[../dashboard/roadmap]] · [[../libraries/brain-roadmap]]
