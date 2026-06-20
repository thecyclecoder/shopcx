# Improve Queue (answered-by-the-box surfacing) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[box-ticket-improve]] (the box-hosted ticket Improve agent). Pure read-over [[../tables/ticket_improve_chats]] — no schema change.

A **queue page** so the founder / CX manager can fire off several **Improve** turns, navigate away, and **see at a glance which ones the box has answered** — then jump straight to those tickets. Today a box Improve turn takes minutes and the only signal is the open ticket's spinner; if you queued three and walked away, you have to re-open each ticket to check. This surfaces them in one list. **It just needs to surface the ticket** (subject + a deep-link to its Improve tab) with its turn state.

**Outcome:** start N Improve turns → glance at the Improve Queue → the ones marked **Answered** / **Needs approval** are the box's replies waiting on you → click through. No re-opening tickets to poll.

## Mechanism (read-only over `ticket_improve_chats`)
[[../tables/ticket_improve_chats]] already has everything: one row per ticket with `turn_status` (`idle｜thinking｜error｜awaiting_approval`), `pending_plan`, `messages`, `ticket_id`, `updated_at`. The queue is a workspace-scoped read of that table joined to `tickets` for the subject/customer.

- **New page** `/dashboard/tickets/improve` (link it from the tickets nav + the to-dos page, since it lives "by the to-dos").
- **New API** `GET /api/tickets/improve-queue` (owner/admin/cs) → the workspace's `ticket_improve_chats` rows + joined `tickets.subject` + customer name, ordered `updated_at desc`.
- **No migration** — the data exists.

## What each state means (the surfacing logic)
- **Answered — go read** → `turn_status='idle'` **and the last `messages` entry is the assistant's** (box replied, you haven't sent a new turn since). The primary "the box got back to you" signal.
- **Needs approval** → `turn_status='awaiting_approval'` (a `pending_plan` is parked — the box proposed actions and is waiting for your Approve/Decline).
- **Thinking…** → `turn_status='thinking'` (a box turn is in flight; still cooking).
- **Error — retry** → `turn_status='error'` (`last_error` shown; sending again retries).

## UX
- Two groups: **"Waiting on you"** (Answered · Needs approval · Error) pinned on top, **"In progress"** (Thinking…) below. Each row: ticket subject + customer · a status chip · relative `updated_at` · → links to `/dashboard/tickets/{ticket_id}` (opens the Improve tab).
- A **count badge** on the tickets-nav "Improve" link = number of "Waiting on you" sessions, so it's visible without opening the page.
- Polls every ~5–10 s (or revalidates on focus) so a turn flipping `thinking → idle/awaiting_approval` shows up without a manual refresh.
- Workspace-scoped (shared queue — founder + CX manager see the same), newest activity first.

## Out of scope (v1)
- Unread/seen tracking (a `last_seen_at` per row to distinguish "answered & already read" from "answered & new"). v1 relies on live `turn_status` + last-message-role; if we want a true unread badge that clears on open, add `last_seen_at` in v2.
- Acting on the ticket from the queue (approve/reply inline) — the queue only *surfaces + links*; you act on the ticket's Improve tab.

## Verification
- On `/dashboard/tickets/{id}` Improve tab, send a turn → on `/dashboard/tickets/improve` it appears under **In progress / Thinking…** within ~8s (auto-poll). When the box replies (`turn_status: thinking → idle`, assistant message appended) → expect it to move to **Waiting on you / Answered** and the sidebar **Tickets → Improve** badge to increment.
- On any **Answered / Needs approval / Error** row, click it → expect to land on `/dashboard/tickets/{ticket_id}` (open its Improve tab) with the reply / parked plan / error.
- Send a turn that yields a plan (`turn_status='awaiting_approval'`) → expect chip **Needs approval**. A turn that errors (`turn_status='error'`) → expect chip **Error — retry** with `last_error` shown under the subject.
- Queue 3 Improve turns on 3 tickets, navigate away, open `/dashboard/tickets/improve` → expect all 3 visible with their live states (grouped Waiting-on-you above In-progress); no ticket re-opening needed.
- As a `cs_manager` → expect the queue + badge to load (200). As a viewer/agent role with no Improve access → expect `GET /api/tickets/improve-queue` to 403 and the badge to stay hidden.

## Phases
- ✅ **P1:** `GET /api/tickets/improve-queue` (owner/admin/cs, read-over `ticket_improve_chats` + `tickets`/`customers`, derived `queue_state`) + the `/dashboard/tickets/improve` page (two groups, status chips, deep-links, ~8s poll + focus-revalidate) + the sidebar **Tickets → Improve** count badge (`counts.waiting`). Brain: [[../tables/ticket_improve_chats]] "## Improve Queue surface" note + [[../dashboard/tickets__improve]] page entry. No migration. Ready to fold.
