# Authoring chat persistence — save + resume Opus chats (cross-device) ✅

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate "Autonomous build platform"

The Roadmap authoring chat ([[../lifecycles/roadmap-build-console]] Phase 2) keeps its conversation only in the modal's in-memory React state (`AuthoringChat.tsx`) — closing the modal or navigating away **loses the thread**. Persist conversations in a DB so you can leave mid-chat and **resume from any device** (start on the laptop, finish on the phone), matching the phone-first workflow + the system's "live DB companion" pattern.

**Business outcome:** no lost work when you step away mid-refinement; chats become resumable, like a real assistant.

## Phase 1 — `roadmap_chats` table ✅
- ✅ New table `public.roadmap_chats` (migration `supabase/migrations/20260618140000_roadmap_chats.sql`; idempotent): `id uuid pk default gen_random_uuid()`, `workspace_id uuid not null references workspaces(id) on delete cascade`, `user_id uuid`, `spec_slug text` (nullable — null = a "New feature" chat not yet saved as a spec; set once a slug exists), `title text`, `messages jsonb not null default '[]'` (the `[{role,content}]` transcript), `status text not null default 'active'` (`active`｜`finalized`), `created_at`/`updated_at timestamptz`. **Applied to prod** via `scripts/apply-roadmap-chats-migration.ts`.
- ✅ Indexes: `(workspace_id, user_id, updated_at desc)`, `(workspace_id, spec_slug)`. RLS: members read their workspace rows (`roadmap_chats_select`), service role all (`roadmap_chats_service`).
- ✅ **This migration was the gated action** — it exercised the "Approve & apply migration" round-trip live (the approval gate's first real exercise; first attempt surfaced a generic failure, hardened the apply script's env loading, second attempt succeeded).

## Phase 2 — Persistence API ✅
- ✅ `src/app/api/roadmap/chat-session/route.ts` (owner-gated, mirrors the existing roadmap routes' auth):
  - `POST` `{ id?, spec_slug?, title, messages, status? }` → upsert the session, return `{ id }`.
  - `GET ?id=` → load one session; `GET ?slug=` → the latest `active` session for that spec; `GET` (no params) → recent sessions for the user/workspace (for a resume list).
- ✅ Server lib helpers in `src/lib/roadmap-chats.ts` (types + load/save via `createAdminClient()`).

## Phase 3 — Wire `AuthoringChat.tsx` ✅
- ✅ On open: for **Refine** (has `slug`) load the latest `active` session for that slug and offer **Resume** vs **Start fresh**; for **New feature** offer a recent-chats list (Phase 4) or fresh.
- ✅ **Autosave** the transcript (debounced ~800 ms, serialized) to the session as the conversation progresses — and **don't clear on close** (persist; only clear local UI state).
- ✅ On finalize (Save spec / Save & build), set the session `status='finalized'` + its `spec_slug`.

## Phase 4 — Resume affordance ✅
- ✅ A "Resume chat" picker (recent active sessions) inside the **New feature** modal + a Resume-vs-Start-fresh banner on **Refine**, so you can pick up an in-progress chat — cross-device, since it's DB-backed.

## Safety / invariants
- Owner-only; sessions are **workspace-scoped** (RLS). Transcripts are plain conversation — no secrets persisted.
- One `active` session per `(user, spec_slug)` to avoid clutter (upsert on that key for refine).
- Saving a chat ≠ committing a spec — the spec is still only written on finalize (existing behavior).

## Completion criteria
- Start a chat, navigate away (or refresh, or switch device), reopen → the conversation is **restored** and you can keep going.
- Finalizing marks the session finalized and links its `spec_slug`.

## Verification
- On `/dashboard/roadmap/{any-spec}`, open **Refine with Opus**, send one message, **close** the modal, then reopen it → expect a **"Resume chat"** banner showing your in-progress thread (N messages, last-updated time); tap Resume → the prior messages are restored and you can keep typing.
- Start a **New feature** chat from the board header, type a message, close it, then reopen the New-feature chat (or load the board on a second device) → expect the chat in the **recent-chats** resume list.
- In a resumed chat tap **Save spec** (or **Save & build**) → expect the success card, and that the session no longer appears as an active resume candidate for that slug (it's marked `finalized`).
- (Optional DB check) probe `public.roadmap_chats` → expect one row per chat with `messages` jsonb populated and `status` flipping `active` → `finalized` on save.

## Related
[[roadmap-build-console]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]] · [[../tables/agent_jobs]] · [[../project-management]]
