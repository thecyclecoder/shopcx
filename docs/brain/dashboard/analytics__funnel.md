# Dashboard · analytics/funnel

_TODO: page purpose._

**Route:** `/dashboard/analytics/funnel`

## Features

**Page title:** Pack size chosen

**Visible buttons (heuristic — actual labels in source):**
- Approve
- Reject

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/cart-analytics`
- `/api/workspaces/:x/chapter-diagnostics`
- `/api/workspaces/:x/funnel-tree`
- `/api/workspaces/:x/storefront-campaign-grades/:x`
- `/api/workspaces/:x/storefront-grader-prompts/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/funnel/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
