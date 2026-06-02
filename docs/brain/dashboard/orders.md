# Dashboard · orders

Order list with filters. Detail view shows line items, fulfillments, transactions, attribution.

**Route:** `/dashboard/orders`

## Features

**Page title:** Orders

**Visible buttons (heuristic — actual labels in source):**
- Search
- Clear
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[orders/[id]]]

## API endpoints called

- `/api/workspaces/:x/orders`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/orders/page.tsx` — the page itself
- `src/app/dashboard/orders/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
