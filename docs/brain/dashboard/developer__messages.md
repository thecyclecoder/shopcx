# Dashboard · developer/messages

The Developer Message Center — the founder's "ask the box anything" console + the single place to reach every agent. Owner-only tabs: **Chat** (default, read-only dev-ask console — see [[../lifecycles/developer-message-center]]), **one tab per live+leashed director** (Ada · Max · June … — the leash-bound coach/ask/plan chat, [[../lifecycles/director-cockpits]]), and **Eve** (the elevated god-mode desk mirror — see [[../lifecycles/god-mode]] and [[../specs/god-mode]]). Director tabs are the `director-chats-in-message-center` goal's front door; Eve stays visually + behaviorally distinct as company-wide god mode.

**Route:** `/dashboard/developer/messages`

## Features

**Rendering:** Client component (`"use client"` in `MessageCenterChat.tsx`), server route wraps it.

- **Chat tab** — one thread of the read-only dev-ask console. POSTs to `/api/developer/messages` which enqueues a `kind='dev-ask'` job.
- **Director tabs** — one per director returned by `GET /api/director/coach/directors` (live in the org chart AND has a registered `<name>-director.ts` leash module — currently Ada/platform, Max/growth, June/cs; Marco/logistics stays tab-less while his seat is dormant). Each mounts the shared `DirectorCoachChat` with `directorFunction={slug}` (keyed on slug for a clean remount), which POSTs `director_function` to `/api/director/coach` so a new thread runs AS that director and resumes only that director's threads. Leash-bound (ask/plan/coach); anything on a rail escalates to the CEO. See [[../lifecycles/director-cockpits]] · [[../libraries/director-coach-threads]].
- **Eve (God Mode) tab** — the elevated mirror of the [[../lifecycles/god-mode]] `/god/[token]` cockpit. Only visible when `workspace.role === 'owner'`; the button itself is hidden for non-owners. Every `/api/god-mode/*` endpoint additionally re-gates with `requireOwner` server-side — never trust the client. Reuses the Phase-3 cockpit UX (Chat + Approvals cards, PIN input for destructive, Ask/Deny/Approve).

## Sub-routes

_None._

## API endpoints called

**Chat tab:**
- `GET /api/developer/messages` — recent threads.
- `GET /api/developer/messages?id=<thread>` — one thread.
- `POST /api/developer/messages` — send / retry / approve dev-ask actions.

**Director tabs (all owner-gated):**
- `GET /api/director/coach/directors` — the tab list: `{ directors: [{ slug, name, personaAccent, leashSummary }] }`, live+leashed only, org-chart order. Eve is deliberately excluded.
- `GET /api/director/coach` — recent coach threads (the component resumes the latest thread whose `director_function` matches its tab).
- `GET /api/director/coach?id=<thread>` — one thread.
- `POST /api/director/coach` — send (`director_function` picks the director on a new thread) / retry / approve coach actions; enqueues a `kind='director-coach'` job.

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
- `src/app/dashboard/developer/messages/MessageCenterChat.tsx` — parent client component holding the Chat / director / Eve tab bar; fetches `/api/director/coach/directors` and mounts `DirectorCoachChat` per director tab.
- `src/app/dashboard/developer/messages/GodModeTab.tsx` — Eve god-mode tab (owner-only). Renders the same Chat + Approvals UX as the cockpit but hits `/api/god-mode/*` instead of `/api/god/[token]/*`.
- `src/components/agents/director-coach-chat.tsx` — the shared director coach/ask/plan chat, parameterized by `directorFunction` / `directorName` (also used standalone on `/dashboard/agents/[role]`).
- `src/app/api/director/coach/directors/route.ts` — the live+leashed director list backing the tab bar.

---

[[../README]] · [[../../CLAUDE]] · [[../lifecycles/god-mode]] · [[../specs/god-mode]]
