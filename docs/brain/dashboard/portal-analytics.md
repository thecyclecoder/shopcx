# Dashboard · portal-analytics

Customer-portal usage stats. Action funnel (pause / cancel / address change / coupon apply).

**Route:** `/dashboard/portal-analytics`

## Features

**Page title:** Portal Analytics

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

_None._

## API endpoints called

- `/api/workspaces/:x/portal-analytics`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/portal-analytics/page.tsx` — the page itself

---

[[../README]] · [[../../CLAUDE]]
