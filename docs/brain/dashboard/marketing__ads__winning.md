# Dashboard · marketing/ads/winning

_TODO: page purpose._

**Route:** `/dashboard/marketing/ads/winning`

## Features

**Page title:** Winning statics

**Visible buttons (heuristic — actual labels in source):**
- Archive

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/ads/creative-finder`
- `/api/ads/creative-finder/:x`
- `/api/ads/creative-finder/patterns`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/ads/winning/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
