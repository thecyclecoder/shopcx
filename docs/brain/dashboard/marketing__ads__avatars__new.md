# Dashboard · marketing/ads/avatars/new

_TODO: page purpose._

**Route:** `/dashboard/marketing/ads/avatars/new`

## Features

**Page title:** New avatar

**Visible buttons (heuristic — actual labels in source):**
- Cancel

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/ads/avatars`
- `/api/ads/avatars/archetypes`
- `/api/ads/avatars/candidates`
- `/api/ads/avatars/upload`
- `/api/ads/proposals`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/ads/avatars/new/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
