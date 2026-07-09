# Dashboard · analytics/dunning

_TODO: page purpose._

**Route:** `/dashboard/analytics/dunning`

## Features

**Page title:** Dunning Analytics

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/analytics/dunning` — backed by [[../libraries/analytics-tile-rpcs]] `dunning_cycle_status_counts` RPC

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/analytics/dunning/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
