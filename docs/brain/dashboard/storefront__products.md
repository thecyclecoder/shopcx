# Dashboard · storefront/products

_TODO: page purpose._

**Route:** `/dashboard/storefront/products`

## Features

**Page title:** Products

**Filters:**
- status: { value: active, label: Active },
  { value: draft, label: Draft },
  { value: archived, label: Archived },
  { value: all, label: All statuses },

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[storefront/products/[id]]]

## API endpoints called

- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/storefront/products/page.tsx` — the page itself
- `src/app/dashboard/storefront/products/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
