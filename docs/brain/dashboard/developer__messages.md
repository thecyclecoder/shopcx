# Dashboard · developer/messages

The Developer Message Center — the founder's "ask the box anything" console. Two tabs (owner-only): **Chat** (default, read-only dev-ask console — see [[../lifecycles/developer-message-center]]) and **God Mode** (Phase-4 elevated god-mode desk mirror — see [[../lifecycles/god-mode]] and [[../specs/god-mode]]).

**Route:** `/dashboard/developer/messages`

## Features

**Rendering:** Client component (`"use client"` in `MessageCenterChat.tsx`), server route wraps it.

- **Chat tab** — one thread of the read-only dev-ask console. POSTs to `/api/developer/messages` which enqueues a `kind='dev-ask'` job.
- **God Mode tab** — the elevated mirror of the [[../lifecycles/god-mode]] `/god/[token]` cockpit. Only visible when `workspace.role === 'owner'`; the button itself is hidden for non-owners. Every `/api/god-mode/*` endpoint additionally re-gates with `requireOwner` server-side — never trust the client. Reuses the Phase-3 cockpit UX (Chat + Approvals cards, PIN input for destructive, Ask/Deny/Approve).

## Sub-routes

_None._

## API endpoints called

**Chat tab:**
- `GET /api/developer/messages` — recent threads.
- `GET /api/developer/messages?id=<thread>` — one thread.
- `POST /api/developer/messages` — send / retry / approve dev-ask actions.

**God Mode tab (all owner-gated):**
- `GET /api/god-mode/session` — resolve the workspace's active god-mode session; returns `{ armed:false }` when none, or `{ armed:true, session, messages, approvals }`. Bumps sliding TTL + `last_activity_at` on every read.
- `POST /api/god-mode/message` — body `{ message }`. Appends the founder turn + enqueues a `kind='god-mode'` `mode:'turn'` job.
- `POST /api/god-mode/approve` — body `{ approvalId, decision, question?, pin? }`. Server enforces the PIN gate against `workspaces.god_mode_pin_hash` for `risk='destructive'` (constant-time `verifyPin`; never leaks validity beyond allow/deny).
- `POST /api/god-mode/arm` — arm a new session (mints cockpit token + returns cockpit URL; the URL is the same one the SMS-linked `/god/[token]` cockpit uses).
- `POST /api/god-mode/disarm` — kill switch. Flips `status='disarmed'` + nulls the cockpit token.

## Permissions

- Chat tab surface — all workspace members can navigate; but the send/approve endpoints (`/api/developer/messages` `POST`) are owner-gated so a non-owner sees an empty console.
- God Mode tab button — HIDDEN for non-owners (`workspace.role === 'owner'` gate at the parent).
- Every `/api/god-mode/*` endpoint RE-gates with `requireOwner` server-side — never trust the client.

## Files touched

- `src/app/dashboard/developer/messages/page.tsx` — the page.
- `src/app/dashboard/developer/messages/MessageCenterChat.tsx` — parent client component holding the Chat/God-Mode tab bar.
- `src/app/dashboard/developer/messages/GodModeTab.tsx` — Phase-4 god-mode tab (owner-only). Renders the same Chat + Approvals UX as the cockpit but hits `/api/god-mode/*` instead of `/api/god/[token]/*`.

---

[[../README]] · [[../../CLAUDE]] · [[../lifecycles/god-mode]] · [[../specs/god-mode]]
