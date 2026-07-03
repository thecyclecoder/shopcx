# Dashboard · subscriptions

List of every subscription across the workspace. Filters by status + recovery (dunning) + payment status. Sort, search, paginate. Detail view at [id].

**Route:** `/dashboard/subscriptions`

## Features

**Page title:** Subscriptions

**Visible buttons (heuristic — actual labels in source):**
- Clear all
- Previous
- Next

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[subscriptions/[id]]]

## API endpoints called

- `/api/workspaces/:x/products`
- `/api/workspaces/:x/subscriptions`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/subscriptions/page.tsx` — the page itself
- `src/app/dashboard/subscriptions/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
