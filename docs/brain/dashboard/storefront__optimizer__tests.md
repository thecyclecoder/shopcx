# Dashboard · storefront/optimizer/tests

_TODO: page purpose._

**Route:** `/dashboard/storefront/optimizer/tests`

## Features

**Page title:** Storefront tests

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[experimentId]/` → [[storefront/optimizer/tests/[experimentId]]]

## API endpoints called

- `/api/workspaces/:x/storefront-experiments`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/storefront/optimizer/tests/page.tsx` — the page itself
- `src/app/dashboard/storefront/optimizer/tests/[experimentId]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
