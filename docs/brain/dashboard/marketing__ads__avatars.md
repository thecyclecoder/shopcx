# Dashboard · marketing/ads/avatars

_TODO: page purpose._

**Route:** `/dashboard/marketing/ads/avatars`

## Features

**Page title:** Avatars

**Visible buttons (heuristic — actual labels in source):**
- Reject
- Archive

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `new/` → [[marketing/ads/avatars/new]]

## API endpoints called

- `/api/ads/avatars`
- `/api/ads/avatars/:x`
- `/api/ads/proposals`
- `/api/ads/proposals/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/ads/avatars/page.tsx` — the page itself
- `src/app/dashboard/marketing/ads/avatars/new/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
