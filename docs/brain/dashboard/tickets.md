# Dashboard · tickets

Master ticket queue. Filters by status, channel, assignee, tags, snooze, escalation. Paginated 25/page. Bulk actions: assign / archive / merge / status change.

**Route:** `/dashboard/tickets`

## Features

**Page title:** Tickets

**Filters:**
- status: all, open, pending, closed, archived
- channel: all, email, chat, portal, social_comments, meta_dm, sms

**Visible buttons (heuristic — actual labels in source):**
- New Ticket
- Cancel
- Delete
- Snoozed
- Save
- Save as View
- Close
- Merge
- Clear
- Previous

**Rendering:** `"use client"` component (client-side state + fetch).

**Escalation indicator:** the amber escalate icon on a row shows whenever the ticket is escalated — `escalated_to` set (a human) **or** `escalated_at` set with `escalated_to` null (the AI Routine). The `<title>` reads "Escalated to AI Routine" for the routine case. The `escalated=true` API filter likewise keys on `escalated_at` so routine-escalated tickets surface. See [[../specs/escalate-to-routine-by-default]].

## Sub-routes

- `[id]/` → [[tickets/[id]]]

## API endpoints called

- `/api/tickets`
- `/api/tickets/bulk`
- `/api/tickets/merge`
- `/api/workspaces/:x/members`
- `/api/workspaces/:x/tags`
- `/api/workspaces/:x/ticket-views`

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls.

## Files touched

- `src/app/dashboard/tickets/page.tsx` — the page itself
- `src/app/dashboard/tickets/[id]/page.tsx` — sub-route
- `src/app/api/tickets/route.ts` — list + create
- `src/app/api/tickets/bulk/route.ts` — bulk operations
- `src/app/api/tickets/merge/route.ts` — merge duplicates

## Related

[[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/ticket_views]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-multi-turn]] · [[../recipes/escalate-ticket]] · [[../recipes/send-email-reply]] · [[../recipes/send-chat-reply]] · [[settings/views]] · [[settings/rules]]

---

[[../README]] · [[../../CLAUDE]]
