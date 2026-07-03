# Dashboard · marketing/ads/upload

_TODO: page purpose._

**Route:** `/dashboard/marketing/ads/upload`

## Features

**Page title:** Upload static ad

**Visible buttons (heuristic — actual labels in source):**
- Remove

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/ads/upload-static`
- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/ads/upload/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
