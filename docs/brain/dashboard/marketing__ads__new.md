# Dashboard · marketing/ads/new

_TODO: page purpose._

**Route:** `/dashboard/marketing/ads/new`

## Features

**Page title:** New ad

**Visible buttons (heuristic — actual labels in source):**
- Regenerate
- Save script
- Refresh

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/ads/angles`
- `/api/ads/avatars`
- `/api/ads/campaigns`
- `/api/ads/campaigns/:x`
- `/api/ads/campaigns/:x/hero`
- `/api/ads/validate`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/ads/new/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
