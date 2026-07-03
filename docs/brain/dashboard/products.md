# Dashboard · products

Product catalog list. Sync trigger, variant editor link, product intelligence + benefit angles.

**Route:** `/dashboard/products`

## Features

**Page title:** Product Intelligence

**Filters:**
- status: { value: active, label: Active },
  { value: draft, label: Draft },
  { value: archived, label: Archived },
  { value: all, label: All statuses },
- intel: { value: all, label: All intelligence },
  { value: started, label: Started },
  { value: not_started, label: Not started },
  { value: published, label: Published },

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[products/[id]]]

## API endpoints called

- `/api/workspaces/:x/products`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/products/page.tsx` — the page itself
- `src/app/dashboard/products/[id]/page.tsx` — sub-route

---

[[../README]] · [[../../CLAUDE]]
