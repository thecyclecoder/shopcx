# roadmap_chats

The DB-backed home for the Roadmap **authoring chat** ([[../lifecycles/roadmap-build-console]] Phase 1 author step). The chat ([[../dashboard/roadmap]] `AuthoringChat.tsx`) used to keep its transcript only in React state, so closing the modal lost the thread. Each row is one persisted conversation — autosaved as you talk, resumable from any device (start on the laptop, finish on the phone). Saving a chat ≠ committing a spec; the spec is still only written on finalize (via [[../specs/roadmap-build-console]]'s chat route). One row per conversation.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `user_id` | `uuid?` | the owner who started the chat (resume list is per-user) |
| `spec_slug` | `text?` | **null = a "New feature" chat** not yet saved as a spec; set on refine (the spec being refined) and on finalize (the slug just written) |
| `title` | `text?` | display label — `Refine: {slug}` for refine, else the first user message (truncated) |
| `messages` | `jsonb` | the `[{role,content}]` transcript · default `[]` |
| `status` | `text` | `active｜finalized` · default `active` |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` bumped on every autosave |

## `status` enum

`active` (an in-progress / resumable chat) → `finalized` (Save spec / Save & build was clicked; `spec_slug` now links the written spec). Only `active` rows surface in resume affordances.

## Indexes / RLS

- `roadmap_chats_user_idx (workspace_id, user_id, updated_at desc)` — recent-chats resume list · `roadmap_chats_slug_idx (workspace_id, spec_slug)` — the latest active session for a refine slug.
- RLS: `roadmap_chats_select` (workspace members read) · `roadmap_chats_service` (service role all writes). The API route writes via `createAdminClient()`.

## Reads/writes

- `src/lib/roadmap-chats.ts` — `saveChat` (upsert), `loadChat`, `loadActiveChatForSlug`, `listRecentChats`.
- `src/app/api/roadmap/chat-session/route.ts` — owner-gated `POST` (upsert → `{ id }`) / `GET ?id=` / `GET ?slug=` / `GET` (recent list).

## Gotchas

- **Owner-only, workspace-scoped.** Transcripts are plain conversation — no secrets persisted.
- **Refine targets one active session per `(user, spec_slug)`** to avoid clutter — `loadActiveChatForSlug` returns the most recent; a stale extra active row just doesn't surface.
- **Autosave is debounced** (~800 ms) and serialized client-side so the first insert returns its `id` before the next save updates it (no duplicate rows).
- **Closing the modal does NOT delete the row** — it persists and only clears local UI state. Resume reloads it.

## Migration

`supabase/migrations/20260618140000_roadmap_chats.sql` (apply: `scripts/apply-roadmap-chats-migration.ts`)

## Related

[[../specs/authoring-chat-persistence]] · [[../lifecycles/roadmap-build-console]] · [[../specs/roadmap-build-console]] · [[../specs/authoring-chat-grounding]] · [[../dashboard/roadmap]] · [[agent_jobs]]
