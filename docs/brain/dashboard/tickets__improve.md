# dashboard/tickets/improve

The **Improve Queue** — a workspace-scoped, read-only surface of every active ticket Improve session, so the founder / CX manager can fire off several box [[../specs/box-ticket-improve|Improve]] turns, walk away, and glance at which ones the box has answered — then deep-link straight to the ticket's Improve tab. Lives "by the to-dos" (Tickets → **Improve**, next to To Do / Escalated).

**Route:** `/dashboard/tickets/improve` · **File:** `src/app/dashboard/tickets/improve/page.tsx` · **API:** `GET /api/tickets/improve-queue`
**Sidebar:** Tickets → **Improve**, with a count bubble = sessions **waiting on you** (`counts.waiting`).

## What it reads
Pure read over [[../tables/ticket_improve_chats]] (one row per ticket) joined to `tickets.subject` + `customers` (name). No schema change — the data already exists. Gated to **owner / admin / cs_manager** (same roles that drive Improve). Active sessions only (`status='active'`); a `resolved` session means the closeout already ran.

## `queue_state` (derived, surfacing logic)
Derived from `turn_status` (+ last message role for the "answered" signal):
- **Answered — go read** → `turn_status='idle'` **and the last `messages` entry is the assistant's** (the box replied, you haven't replied since).
- **Needs approval** → `turn_status='awaiting_approval'` (a `pending_plan` is parked).
- **Error — retry** → `turn_status='error'` (`last_error` surfaced; sending again retries).
- **Thinking…** → `turn_status='thinking'` (a turn is in flight).
- `idle` with no assistant-last message → not surfaced (nothing waiting).

## Two groups
- **Waiting on you** (Answered · Needs approval · Error) — pinned on top.
- **In progress** (Thinking…) — below.
Each row: ticket subject + customer · status chip · relative `updated_at` · → links to `/dashboard/tickets/{ticket_id}` (the Improve tab). Polls every ~8s + revalidates on window focus.

## Surfaces, never acts
The queue only surfaces + links. You Approve / reply on the ticket's Improve tab ([[tickets__id]]) — the queue has no action buttons (the [[../operational-rules]] § North star supervision boundary stays on the ticket).

## Related
[[tickets__id]] · [[tickets__todos]] · [[tickets__escalated]] · [[../tables/ticket_improve_chats]] · [[../specs/box-ticket-improve]] · [[../libraries/ticket-improve-chats]]
