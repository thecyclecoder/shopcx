# Dashboard · products

Product catalog list. Sync trigger, variant editor link, product intelligence + benefit angles.

**Route:** `/dashboard/products`

## Features

**Page title:** Product Intelligence

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/` → [[products/[id]]]
- `new/` → [[products/new]]

## API endpoints called

- `/api/workspaces/:x/product-intelligence`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/products/page.tsx` — the page itself
- `src/app/dashboard/products/[id]/page.tsx` — sub-route
- `src/app/dashboard/products/new/page.tsx` — sub-route

## Related

[[../tables/products]] · [[../tables/product_variants]] · [[../tables/product_intelligence]] · [[../inngest/sync-shopify]]

---

[[../README]] · [[../../CLAUDE]]
