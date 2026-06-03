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

## Ad-tool note

The structured Engine fields this page surfaces are the canonical claim source for the [[../lifecycles/ad-render|ad tool]] (Tier 1-5 data-source contract): `product_page_content`, `product_benefit_selections`, `product_ingredient_research`, `product_reviews`, plus `products.certifications` / `allergen_free` / `awards` / `target_customer`. The ad tool's Phase 0 asset prep — the **Physical dimensions** card, per-variant **Isolated image** upload, and per-variant dimension override — lives on the storefront product detail page; see [[storefront__products]]. APIs: `PATCH /api/workspaces/{id}/products/{productId}/dimensions` and `GET|POST|DELETE /api/workspaces/{id}/products/{productId}/variants/{variantId}/isolated-image`.

## Related

[[../tables/products]] · [[../tables/product_variants]] · [[../lifecycles/product-intelligence]] · [[../lifecycles/ad-render]] · [[../inngest/sync-shopify]]

---

[[../README]] · [[../../CLAUDE]]
