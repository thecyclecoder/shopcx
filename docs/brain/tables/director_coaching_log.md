# director_coaching_log

The **CEO→Director communication log** — one row per coaching act, surfaced as the director's coaching history. Mirrors [[worker_coaching_log]] one level up. Written by [[../libraries/director-instructions]] `coachDirector` alongside the [[director_instructions]] amendment it logs. [[../specs/worker-grading-and-director-management]] Phase 7.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `director_function` | `text` | — | the director coached (the recipient) |
| `coached_by` | `text` | — | the coaching seat — `ceo` · default `ceo` |
| `error_class` | `text` | — | the class of decision addressed |
| `triggering_pattern` | `text` | — | default `''` |
| `old_instruction` / `new_instruction` | `text` | ✓ / — | the guidance diff (old null on a first coaching for the class) |
| `reasoning` | `text` | — | default `''` |
| `instruction_id` | `uuid` | ✓ | → [[director_instructions]].id · the amendment this logged |
| `source_thread_id` | `uuid` | ✓ | → [[director_coach_threads]].id |
| `attempt` | `int` | — | which coaching attempt for the (director, class) · default 1 |
| `kind` | `text` | — | `coaching` (open vocab) · default `coaching` |
| `created_at` | `timestamptz` | — | default `now()` |

**Indexes:** `(workspace_id, director_function, created_at desc)` (history); `(director_function, error_class, created_at desc)` (attempt counting).

## RLS
Authenticated SELECT (owner-gated above the DB), service-role write — mirror [[worker_coaching_log]].

## Migration
`supabase/migrations/20260705140000_director_coaching.sql`. Idempotent.

---

[[../README]] · [[director_instructions]] · [[director_coach_threads]] · [[worker_coaching_log]] · [[../libraries/director-instructions]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
