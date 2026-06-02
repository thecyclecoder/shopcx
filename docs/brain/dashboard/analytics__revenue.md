# Dashboard · analytics/revenue

_TODO: page purpose._

**Route:** `/dashboard/analytics/revenue`

## Features

**Page title:** Revenue Analytics

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/revenue`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/revenue/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
