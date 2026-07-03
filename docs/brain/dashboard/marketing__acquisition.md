# Dashboard · marketing/acquisition

_TODO: page purpose._

**Route:** `/dashboard/marketing/acquisition`

## Features

**Page title:** Acquisition Research

**Visible buttons (heuristic — actual labels in source):**
- Override
- Reject

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/ads/acquisition`
- `/api/ads/acquisition/grades/:x`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/marketing/acquisition/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
