# roadmap_chats

The DB-backed home for the Roadmap **authoring chat** ([[../lifecycles/roadmap-build-console]] Phase 1 author step). The chat ([[../dashboard/roadmap]] `AuthoringChat.tsx`) used to keep its transcript only in React state, so closing the modal lost the thread. Each row is one persisted conversation — resumable from any device (start on the laptop, finish on the phone). Saving a chat ≠ committing a spec; the spec is still only written on finalize. One row per conversation.

**Box-hosted (box-spec-chat).** The chat no longer calls the Anthropic API: a row is a **long-running, resumable `claude -p` session on Max** running on the build box (full working-tree `Read`/`Grep`/`Glob` over `docs/brain/` + `src/`, `WebSearch`, accumulated context across turns). Each user turn enqueues a `kind='spec-chat'` [[agent_jobs]] row (its own concurrency-1 lane) that **resumes the same box session**; the box appends the reply. The route just appends the user message + flips `turn_status='thinking'`; the **DB is the source of truth for the transcript** (the box owns assistant appends — there is no client-side message autosave anymore, which would race the box's writes). The UI (`AuthoringChat`) gets the box's reply **live via Realtime Broadcast** (roadmap-box-broadcast) — see the trigger below — instead of polling `chat-session?id=` on a timer.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `user_id` | `uuid?` | the owner who started the chat (resume list is per-user) |
| `spec_slug` | `text?` | **null = a "New feature" chat** not yet saved as a spec; set on refine (the spec being refined) and on finalize (the slug just written) |
| `title` | `text?` | display label — `Refine: {slug}` for refine, else the first user message (truncated) |
| `messages` | `jsonb` | the `[{role,content}]` transcript · default `[]` · the route appends the user turn, the box (`runSpecChatJob`) appends the assistant reply |
| `status` | `text` | `active｜finalized` · default `active` |
| `box_session_id` | `text?` | **box-spec-chat** — the resumable `claude -p` Max session id; null until turn 1 runs. Later turns `claude --resume <this>` (cwd-stable per-chat worktree). |
| `turn_status` | `text` | **box-spec-chat** — `idle｜thinking｜error` · default `idle`. `thinking` while a spec-chat job is in flight (composer disables + "thinking on the box…"); `error` on box failure (UI shows Retry → re-resumes the session). |
| `last_error` | `text?` | **box-spec-chat** — the failure reason surfaced when `turn_status='error'` |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` bumped on every turn |

## `status` enum

`active` (an in-progress / resumable chat) → `finalized` (Save spec / Save & build was clicked; `spec_slug` now links the written spec). Only `active` rows surface in resume affordances. **Finalize is now box-driven:** the box resumes the session, emits the full spec markdown, and the worker commits it to `main` + flips `status='finalized'` (+ queues a `build` job if Save & build).

## `turn_status` lifecycle (box-spec-chat)

`idle` → **`thinking`** (the route appended a user turn + enqueued a `spec-chat` job) → `idle` (the box appended its reply / committed the finalized spec) · or → **`error`** (the box turn failed; `last_error` set, the job is `failed`). The UI ([[../dashboard/roadmap]] `AuthoringChat`) refreshes on the **Realtime Broadcast** the trigger below fires — the box's write here (turn complete) pushes the reply the instant it lands, with a 3s backstop; a Retry re-enqueues a turn that **resumes the same `box_session_id`**.

### Trigger — `roadmap_chats_broadcast_trg` (live authoring chat)

`20261203120000` (roadmap-box-broadcast). An `after insert or update` trigger that `realtime.send(..., 'box_change', 'box:'||workspace_id, private)`, so `AuthoringChat` gets the box's turn-complete write live instead of polling. Feeds the same per-workspace `box:<ws>` topic as [[agent_jobs]] + [[worker_heartbeats]], consumed by [[../libraries/use-box-live]]. Broadcast (not Postgres Changes); see [[../recipes/realtime-subscriptions]].

## Indexes / RLS

- `roadmap_chats_user_idx (workspace_id, user_id, updated_at desc)` — recent-chats resume list · `roadmap_chats_slug_idx (workspace_id, spec_slug)` — the latest active session for a refine slug.
- RLS: `roadmap_chats_select` (workspace members read) · `roadmap_chats_service` (service role all writes). The API route writes via `createAdminClient()`.

## Reads/writes

- `src/lib/roadmap-chats.ts` — `saveChat` (upsert), `loadChat`, `loadActiveChatForSlug`, `listRecentChats`, `markTurnThinking` (append a user turn + set `turn_status='thinking'`). Type carries `box_session_id`/`turn_status`/`last_error`.
- `src/app/api/roadmap/chat-session/route.ts` — owner-gated `POST` (upsert → `{ id }`) / `GET ?id=` / `GET ?slug=` / `GET` (recent list). The `GET ?id=` is what `AuthoringChat.tsx` polls for `turn_status`.
- `src/app/api/roadmap/chat/route.ts` — owner-gated; **enqueues** `spec-chat` [[agent_jobs]] (turn/finalize/verify), no longer calls Anthropic.
- `scripts/builder-worker.ts` → `runSpecChatJob` — the box side: resumes the session, appends the reply (turn) / commits the spec to main + queues a build (finalize) / commits a `## Verification` section (verify).

## Gotchas

- **Owner-only, workspace-scoped.** Transcripts are plain conversation — no secrets persisted.
- **Refine targets one active session per `(user, spec_slug)`** to avoid clutter — `loadActiveChatForSlug` returns the most recent; a stale extra active row just doesn't surface.
- **The DB owns the transcript now (box-spec-chat).** The old debounced client autosave is gone — the route appends the user turn and the box appends the assistant reply, so a stale client write can't clobber the box's append. The client only mirrors `messages` from the poll.
- **Closing the modal does NOT delete the row** — it persists and only clears local UI state. Resume reloads it (and resumes polling if `turn_status='thinking'`).
- **`box_session_id` is cwd-scoped.** `claude --resume` finds a session by its project (cwd), so the box runs every turn of a chat in the **same** stable worktree path (`builds/spec-chat-{chat_id}`), recreated on `origin/main` each turn. Concurrency-1 keeps two turns from racing that dir.

## Migration

`supabase/migrations/20260618140000_roadmap_chats.sql` (apply: `scripts/apply-roadmap-chats-migration.ts`) + `20260620120000_roadmap_chats_box_session.sql` (adds `box_session_id`/`turn_status`/`last_error`; apply: `scripts/apply-roadmap-chats-box-session-migration.ts`)

## Related

[[../lifecycles/roadmap-build-console]] · [[../libraries/roadmap-chats]] · [[../dashboard/roadmap]] · [[agent_jobs]]
