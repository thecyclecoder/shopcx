# Dashboard · csat

CSAT survey dashboard. Resolution-gate stats (did we resolve?), rating distribution, comment list. Per-channel + per-agent breakdowns.

**Route:** `/dashboard/csat`

## Features

**Page title:** CSAT

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/csat`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/csat/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
