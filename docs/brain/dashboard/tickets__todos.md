# Dashboard · tickets/todos

_TODO: page purpose._

**Route:** `/dashboard/tickets/todos`

## Features

**Page title:** To Do

**Filters:**
- status: pending, approved, executed, rejected, superseded, failed, all
- urgency: all, urgent, normal, low
- source: all, ticket, csat, cron, manual
- action_type: all,
  customer_reply,
  customer_action,
  ticket_close,
  ticket_analysis_rescore,

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[tickets/todos/[id]]]

## API endpoints called

- `/api/todos`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/tickets/todos/page.tsx` — the page itself
- `src/app/dashboard/tickets/todos/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
