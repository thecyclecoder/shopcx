# Dashboard · analytics/profit

_TODO: page purpose._

**Route:** `/dashboard/analytics/profit`

## Features

**Page title:** Profit Estimate

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/profit`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/profit/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
