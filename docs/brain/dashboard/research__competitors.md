# Dashboard · research/competitors

The owner-facing, read-only browse surface for [[../tables/competitors]] — the DB-driven competitor set the [[../inngest/creative-scout]] reads per product. Discovery + approval stay on the Acquisition Research Hub; this page is the "browse" surface: filter by product, group by product, inspect a row's evidence.

**Route:** `/dashboard/research/competitors`

## Features

**Page title:** Competitors

**Rendering:** `"use client"` component (client-side state + fetch).

**Layout — grouped by product (Phase 2 of [[../specs/competitor-sdk-chokepoint-and-per-product-cleanup]]):** the page renders one section per product, each with the product title as the group heading + a row count and its own table. Named-product groups sort alphabetically by product title; workspace-scoped rows (null `product_id` — the legacy migrated seeds) render last under a "Workspace-level (unscoped)" heading and disappear once Phase 3 purges them.

**Product filter — strict per-product:** the product `<select>` filters the API to ONE product's rows. The GET `/api/ads/competitors?workspaceId=&productId=` route now returns strictly per-product results — no fold of null-scoped rows into every product view (Phase 2 replaced the legacy `product_id.eq.{id} OR product_id.is.null` OR filter with `listCompetitors({workspaceId, productId, status})` from the [[../libraries/competitors]] SDK). "All products" is the default; picking a product collapses the page to that single group.

Sort within each group: approved → proposed → rejected, then brand ascending (matches the sweep's priority order). Whitelisted-page rows render the raw `search_keyword` in place of `brand` and a "runs ads for {brand}" sub-line resolved server-side via the SDK's `getCompetitorBrandsById`.

## Sub-routes

_None._

## API endpoints called

- `/api/ads/competitors?workspaceId=&productId=` — the [[../libraries/competitors]] SDK-backed list (strict per-product when `productId` is set).
- `/api/workspaces/:x/products?status=all` — the product `<select>` source (draft/archived included so scoping stays consistent with the sibling [[research__adGaps]] hub).

## Permissions

Role-aware UI — the page reads `workspace.role` to show / hide controls. Only `role === 'owner'` sees the surface; anyone else sees "This surface is owner-only." The API itself also returns 403 for non-owner/admin.

## Files touched

- `src/app/dashboard/research/competitors/page.tsx` — the page itself
- `src/app/api/ads/competitors/route.ts` — the GET the page fetches
- `src/lib/competitors.ts` — `listCompetitors` / `getCompetitorBrandsById`

---

[[../README]] · [[../../CLAUDE]] · [[../libraries/competitors]] · [[../tables/competitors]] · [[../specs/competitor-sdk-chokepoint-and-per-product-cleanup]]
