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

## Ad-tool asset prep (Phase 0)

The product **detail** page (`[id]/`) is where the ad tool's product references are set (see [[../lifecycles/ad-render]] Phase 0). Three surfaces:

- **Per-product "Physical dimensions" card** — length / width / height / weight numeric inputs + a `shape` dropdown (`bag`/`box`/`bottle`/`jar`/`pouch`/`other`). Saves to [[../tables/products]].`physical_dimensions` (jsonb). These get baked into the Higgsfield Soul prompt so the avatar holds a correctly-scaled product.
- **Per-variant "Isolated image" upload** — a cut-out (background-removed) product shot per variant, stored in the private `ad-tool` bucket and written to [[../tables/product_variants]].`isolated_image_url` (+ `isolated_image_uploaded_at` / `_by`). This is what Soul receives as `reference_image_urls[]`. **The ad builder hard-blocks Generate Hero until a variant has one.**
- **Per-variant dimension override** — same dimension inputs, collapsible, defaults to "inherit from product." Variant-level `physical_dimensions` wins over product-level when set.

Both uploads accept PNG / JPG / WEBP (max 10 MB), no server-side resize.

## API endpoints called

- `/api/workspaces/:x/products`
- `PATCH /api/workspaces/{id}/products/{productId}/dimensions` — save product physical dimensions (+ variant override)
- `GET|POST|DELETE /api/workspaces/{id}/products/{productId}/variants/{variantId}/isolated-image` — fetch / upload / remove a variant's isolated image

## Permissions

All workspace members. No role gate in the page itself; gated only by middleware auth + workspace membership.

## Files touched

- `src/app/dashboard/storefront/products/page.tsx` — the page itself
- `src/app/dashboard/storefront/products/[id]/page.tsx` — sub-route (dimensions card + isolated-image uploads)
- `src/app/api/workspaces/[id]/products/[productId]/dimensions/route.ts` — dimensions PATCH
- `src/app/api/workspaces/[id]/products/[productId]/variants/[variantId]/isolated-image/route.ts` — isolated-image GET/POST/DELETE

## Related

[[../lifecycles/ad-render]] · [[../tables/products]] · [[../tables/product_variants]] · [[../integrations/higgsfield]]

---

[[../README]] · [[../../CLAUDE]]
