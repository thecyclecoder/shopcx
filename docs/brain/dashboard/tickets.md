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

## Sub-routes

- `[id]/` → [[tickets/[id]]]
- `escalated/` → [[tickets/escalated]]
- `improve/` → [[tickets/improve]]
- `todos/` → [[tickets/todos]]
- `analytics/` → [[tickets__analytics]] — Selective-clarify rate + Sol economics tiles

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
- `src/app/dashboard/tickets/escalated/page.tsx` — sub-route
- `src/app/dashboard/tickets/improve/page.tsx` — sub-route
- `src/app/dashboard/tickets/todos/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
