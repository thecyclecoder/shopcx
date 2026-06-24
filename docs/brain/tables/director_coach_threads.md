# director_coach_threads

The **CEO↔Director coaching chat** thread — a resumable Max conversation where the CEO asks the Platform/DevOps Director (Ada) about her decisions ("why haven't you built spec X?"), she explains read-only, and the CEO coaches her. The conversational top rung of the cascade ([[../specs/worker-grading-and-director-management]] Phase 7). Mirrors [[dev_message_threads]] one level up — each turn enqueues a `kind='director-coach'` [[agent_jobs]] row the box runs as a `claude -p` Max session AS the director.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `user_id` | `uuid` | ✓ | the CEO/owner who started the thread |
| `director_function` | `text` | — | the director being coached (default `platform`) |
| `title` | `text` | ✓ | first message, truncated |
| `messages` | `jsonb` | — | `[{role:'user'｜'assistant', content}]` — the conversation · default `[]` |
| `box_session_id` | `text` | ✓ | the resumable `claude -p` session id (null until turn 1); the box `--resume`s it each turn |
| `turn_status` | `text` | — | `idle｜thinking｜error` · default `idle` (the UI polls this) |
| `last_error` | `text` | ✓ | surfaced on `error` |
| `pending_actions` | `jsonb` | — | gated cards: a `coaching` amendment or a `spec` handoff · default `[]` |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Pending-action shapes:** `{type:'coaching', summary, errorClass, guidance, triggeringPattern, reasoning, status}` (on approval the worker writes a [[director_instructions]] row via `coachDirector`); `{type:'spec', summary, slug, title, owner, parent, content, queueBuild, status}` (committed on approval). The model NEVER executes — `runDirectorCoachJob` mode `approve_action` does, on the CEO's click.

**Index:** `(workspace_id, user_id, updated_at desc)` (the resume list).

## The turn/intent model
The CEO's two buttons set `intent` on a turn (in the job `instructions`): **Ask** (`intent='ask'` — she explains, never emits a coaching card) vs **Coach her** (`intent='coach'` — she distills the directive into a `coaching` card for confirmation). The approval card is the explicit confirmation, so a multi-turn convo stays conversation until the CEO presses Coach.

## RLS
Authenticated SELECT (owner-gated at the route/UI), service-role write — mirror [[dev_message_threads]].

## Migration
`supabase/migrations/20260705140000_director_coaching.sql` (apply: `npx tsx scripts/apply-director-coaching-migration.ts`). Creates this + [[director_instructions]] + [[director_coaching_log]]. Idempotent.

---

[[../README]] · [[director_instructions]] · [[director_coaching_log]] · [[dev_message_threads]] · [[agent_jobs]] · [[../libraries/director-coach-threads]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
