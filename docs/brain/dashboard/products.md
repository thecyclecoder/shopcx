# Dashboard · products

All-products list view used as the entry point for the [[../lifecycles/product-intelligence|Product Intelligence Engine]]. Filter by status + intelligence-status; click a product → land on its Engine detail page.

**Route:** `/dashboard/products`

## Features

**Page title:** Product Intelligence

**Filters:**
- Status: Active / Draft / Archived / All
- Intelligence: All / Started / Not started / Published

**Rendering:** `"use client"` component (client-side state + fetch).

## Sub-routes

- `[id]/intelligence/` → the Engine detail page (see [[../lifecycles/product-intelligence]])

## API endpoints called

- `/api/workspaces/:x/products?status=...`

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/products/page.tsx` — the list itself
- `src/app/dashboard/products/[id]/intelligence/page.tsx` — Engine detail (sub-route)

## Related

[[../tables/products]] · [[../tables/product_variants]] · [[../lifecycles/product-intelligence]] · [[../inngest/sync-shopify]]

---

[[../README]] · [[../../CLAUDE]]
