# Dashboard · marketing/ads

_TODO: page purpose._

**Route:** `/dashboard/marketing/ads`

## Features

**Page title:** Ads

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[marketing/ads/[id]]]
- `avatars/` → [[marketing/ads/avatars]]
- `new/` → [[marketing/ads/new]]
- `upload/` → [[marketing/ads/upload]]
- `winning/` → [[marketing/ads/winning]]

## API endpoints called

- `/api/ads/campaigns`
- `/api/ads/campaigns/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/ads/page.tsx` — the page itself
- `src/app/dashboard/marketing/ads/[id]/page.tsx` — sub-route
- `src/app/dashboard/marketing/ads/avatars/page.tsx` — sub-route
- `src/app/dashboard/marketing/ads/new/page.tsx` — sub-route
- `src/app/dashboard/marketing/ads/upload/page.tsx` — sub-route
- `src/app/dashboard/marketing/ads/winning/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
