# dashboard/tickets/improve

The **Improve Queue** — a workspace-scoped, read-only surface of every active ticket Improve session, so the founder / CX manager can fire off several box [[../specs/box-ticket-improve|Improve]] turns, walk away, and glance at which ones the box has answered — then deep-link straight to the ticket's Improve tab. Lives "by the to-dos" (Tickets → **Improve**, next to To Do / Escalated).

**Route:** `/dashboard/tickets/improve` · **File:** `src/app/dashboard/tickets/improve/page.tsx` · **API:** `GET /api/tickets/improve-queue` · `POST /api/tickets/improve-queue/seen { ticket_id }` (mark a session read — owner/admin/cs; `403` other roles, `404` unknown ticket).
**Sidebar:** Tickets → **Improve**, with a count bubble = **unread** sessions waiting on you (`counts.waiting` counts only unread — see Read/unread below).

## What it reads
Pure read over [[../tables/ticket_improve_chats]] (one row per ticket) joined to `tickets.subject` + `customers` (name). Gated to **owner / admin / cs_manager** (same roles that drive Improve). Active sessions only (`status='active'`); a `resolved` session means the closeout already ran. The only added column is `seen_at` (the per-session read marker — see Read/unread below).

## `queue_state` (derived, surfacing logic)
Derived from `turn_status` (+ last message role for the "answered" signal):
- **Answered — go read** → `turn_status='idle'` **and the last `messages` entry is the assistant's** (the box replied, you haven't replied since).
- **Needs approval** → `turn_status='awaiting_approval'` (a `pending_plan` is parked).
- **Error — retry** → `turn_status='error'` (`last_error` surfaced; sending again retries).
- **Thinking…** → `turn_status='thinking'` (a turn is in flight).
- `idle` with no assistant-last message → not surfaced (nothing waiting).

## Read/unread — Mark-as-read / Dismiss ([[../specs/improve-queue-mark-read]])
Without a read marker the queue + nav badge persist forever (you can't clear an FYI reply that had no action). `seen_at timestamptz?` on [[../tables/ticket_improve_chats]] fixes that:
- **Unread** = the box has answered/wants you (`turn_status ∈ {idle, awaiting_approval, error}`) **AND (`seen_at IS NULL` OR `updated_at > seen_at`)**. `updated_at` bumps on every box turn, so a **later** box reply makes `updated_at > seen_at` again → the session **re-surfaces**. The nav badge counts **unread** only, so it always means "genuinely new replies you haven't looked at."
- **Mark read** sets `seen_at = updated_at` (two ways, both just set `seen_at`): an explicit **Mark read** button on each queue row (for FYI replies you don't need to open), or **auto-on-open** — opening the ticket's Improve tab marks the session read (click-through clears it without a second tap).
- **`POST /api/tickets/improve-queue/seen { ticket_id }`** (owner/admin/cs) sets `seen_at`. The Improve tab calls it on mount; the row button calls it directly.
- **Reading ≠ approving:** a read session that still has a parked `pending_plan` (`awaiting_approval`) keeps a distinct **Needs approval** chip — the plan is still actionable on the ticket.

## Three groups
- **Waiting on you** (unread Answered · Needs approval · Error) — pinned on top.
- **Earlier** — read-but-recently-waiting sessions, collapsible + greyed ("read"), so nothing vanishes; a session re-surfaces to "Waiting on you" on its next box turn.
- **In progress** (Thinking…) — below.
Each row: ticket subject + customer · status chip · relative `updated_at` · a **Mark read** affordance · → links to `/dashboard/tickets/{ticket_id}` (the Improve tab). Polls every ~8s + revalidates on window focus.

## Surfaces + dismisses, never acts on the customer
The queue surfaces + links, and lets you **Mark read** (a per-session read marker — not a customer-facing action). You still Approve / reply on the ticket's Improve tab ([[tickets__id]]) — the queue has no customer-acting buttons (the [[../operational-rules]] § North star supervision boundary stays on the ticket).

## Related
[[tickets__id]] · [[tickets__todos]] · [[tickets__escalated]] · [[../tables/ticket_improve_chats]] · [[../specs/box-ticket-improve]] · [[../specs/improve-queue-mark-read]] · [[../libraries/ticket-improve-chats]]
