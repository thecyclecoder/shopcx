# Dashboard · demographics

Customer demographics dashboard. Age band, household income, geo. Cohort snapshots.

**Route:** `/dashboard/demographics`

## Features

**Page title:** Customer Demographics

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/demographics/enrich`
- `/api/workspaces/:x/demographics/status`
- `/api/workspaces/:x/demographics/summary:x`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/demographics/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
