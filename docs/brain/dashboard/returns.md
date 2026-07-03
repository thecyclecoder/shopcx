# Dashboard · returns

Returns list with status, refund amount, tracking. Filters by status / source / freeLabel. Detail view shows label, tracking events, refund attempt history.

**Route:** `/dashboard/returns`

## Features

**Page title:** Returns

**Filters:**
- status: { value: all, label: All Statuses },
  { value: pending, label: Pending },
  { value: open, label: Open },
  { value: label_created, label: Label Created },
  { value: in_transit, label: In Transit },
  { value: delivered, label: Delivered },
  { value: processing, label: Processing },
  { value: restocked, label: Restocked },
  { value: refunded, label: Refunded },
  { value: closed, label: Closed },
  { value: cancelled, label: Cancelled },

**Visible buttons (heuristic — actual labels in source):**
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[returns/[id]]]

## API endpoints called

- `/api/workspaces/:x/returns`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/returns/page.tsx` — the page itself
- `src/app/dashboard/returns/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
