# dev_message_threads

The DB-backed home for the **Developer > Message Center** ([[../specs/developer-message-center]]) — a founder-facing, **read-only** "ask the box anything" console under [[../dashboard/sidebar|Developer]] (owner-only, route `/dashboard/developer/messages`). One row per conversation thread, resumable from any device.

**Box-hosted, read-only analyst + planner.** A thread is a **long-running, resumable `claude -p` session on Max** running on the build box, carrying the **whole brain + full repo + read-only prod DB + `WebSearch`**. Each user turn enqueues a `kind='dev-ask'` [[agent_jobs]] row (its own concurrency-1 lane) that **resumes the same box session**; the box (`runDeveloperMessageJob`) appends the reply. The route just appends the user message + flips `turn_status='thinking'`; the **DB is the source of truth for the transcript** (the box owns assistant appends). The UI polls `GET /api/developer/messages?id=` while `turn_status='thinking'`.

**Report-back, never a builder.** Reads (SELECT/join/analysis via **throwaway, never-committed `scripts/_*.ts`** query scripts in the per-thread worktree) are **silent**. Every proposed DB write / migration / spec handoff stops at an approval card in `pending_actions` — only the owner's click executes it, and only deterministic worker code (`mode:'approve_action'`) runs it. Dedicated table (not riding [[roadmap_chats]]) because the lifecycle differs: **no finalize/spec_slug terminal state**, but it **does carry approval cards**.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `user_id` | `uuid?` | the owner who started the thread (resume list is per-user) |
| `title` | `text?` | display label — the first user message (truncated to 80) |
| `messages` | `jsonb` | the `[{role,content}]` transcript · default `[]` · the route appends the user turn, the box (`runDeveloperMessageJob`) appends the assistant reply |
| `box_session_id` | `text?` | the resumable `claude -p` Max session id; null until turn 1 runs. Later turns `claude --resume <this>` (per-thread worktree, recreated on `origin/main` each turn so brain/code reads are current) |
| `turn_status` | `text` | `idle｜thinking｜error` · default `idle`. `thinking` while a dev-ask job is in flight (composer disables + "thinking on the box…"); `error` on box failure (UI shows Retry → re-resumes the session) |
| `last_error` | `text?` | the failure reason surfaced when `turn_status='error'` |
| `pending_actions` | `jsonb` | gated approval cards · default `[]` · `[{id,type,summary,cmd?,preview?,spec?,payload?,status,result?}]` (see below). Reads never produce one; only a proposed write/migration/spec handoff does. The **latest turn's cards replace** any stale pending ones |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` bumped on every turn |

## `turn_status` lifecycle

`idle` → **`thinking`** (the route appended a user turn + enqueued a `dev-ask` job — or the owner approved a card, enqueuing an `approve_action` job) → `idle` (the box appended its reply / executed the approved cards) · or → **`error`** (the box turn failed; `last_error` set, the job is `failed`). The UI polls `messages?id=` every ~3 s while `thinking`; a Retry re-enqueues a turn that **resumes the same `box_session_id`**.

## `pending_actions` shape (the approval gate)

Each card is `{id, type, summary, status, result?}` plus type-specific fields. `status ∈ pending｜approved｜declined｜done｜failed`. The worker maps the model's typed proposal onto the existing [[agent_jobs]] `PendingAction` shape:

- **`type:'run_prod_script'`** (a **db_mutation**) — `cmd` is a **self-contained shell command** the worker runs on approval in a fresh worktree (holding prod creds); `preview` is the human-readable change. The model never runs the write itself. Schema changes (DDL/migrations) are **not** db_mutations — they ride the spec handoff.
- **`type:'spec'`** (a **gap → spec handoff**) — carries `spec:{slug,title,owner,parent,intent}` where `intent` holds the **full `docs/brain/specs/{slug}.md` markdown** the worker commits to `main` on approval (via the Contents API), and `payload:{queueBuild}` optionally queues a `kind='build'` job — the same spec→build pipeline as [[../specs/box-spec-chat|spec-chat]].

On approval the UI POSTs `{action:'approve', actionId, decision}`; the route flips the card to `approved`/`declined` and (on approve) enqueues a `dev-ask` `{mode:'approve_action'}` job. The worker executes every `approved` card, stamps `done`/`failed` + a `result`, appends a "Done: …" assistant note, and returns `turn_status='idle'`.

## Indexes / RLS

- `dev_message_threads_user_idx (workspace_id, user_id, updated_at desc)` — the recent-threads resume list.
- RLS: `dev_message_threads_select` (workspace members read) · `dev_message_threads_service` (service role all writes). The API route writes via `createAdminClient()`.

## Reads/writes

- `src/lib/dev-message-threads.ts` — `createThread`, `loadThread`, `markThreadThinking` (append a user turn + `turn_status='thinking'`), `setActionDecision` (record approve/dismiss on a card), `listRecentThreads`. Type carries `messages`/`box_session_id`/`turn_status`/`last_error`/`pending_actions`.
- `src/app/api/developer/messages/route.ts` — owner-gated POST (chat/retry/approve) + GET (load/list).
- `scripts/builder-worker.ts` — `runDeveloperMessageJob` (the box turn + the `approve_action` executor).

## Migrations

`supabase/migrations/20260621120000_dev_message_threads.sql` (table + `dev_message_threads_user_idx` + RLS). The `dev-ask` [[agent_jobs]] kind itself needs no migration (free-text `kind`).

## Related

[[../specs/developer-message-center]] · [[agent_jobs]] · [[roadmap_chats]] · [[../recipes/dev-message-center-db]] · [[../libraries/dev-message-threads]] · [[../dashboard/sidebar]]
