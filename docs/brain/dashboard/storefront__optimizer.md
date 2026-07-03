# Dashboard · storefront/optimizer

_TODO: page purpose._

**Route:** `/dashboard/storefront/optimizer`

## Features

**Page title:** Storefront Optimizer

**Visible buttons (heuristic — actual labels in source):**
- Dismiss
- Cancel
- Reject with notes
- Cancel campaign
- Decline

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `tests/` → [[storefront/optimizer/tests]]

## API endpoints called

- `/api/roadmap/approve`
- `/api/workspaces/:x/storefront-optimizer-policy`
- `/api/workspaces/:x/storefront-optimizer-proposals`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/storefront/optimizer/page.tsx` — the page itself
- `src/app/dashboard/storefront/optimizer/tests/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
