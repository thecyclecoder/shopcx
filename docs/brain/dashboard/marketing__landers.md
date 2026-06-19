# Dashboard · Marketing → Landers

`/dashboard/marketing/landers` — lists every auto-generated, ad-matched landing page (the [[../lifecycles/advertorial-landers|advertorial + before/after landers]]) with its public URL, so an operator can grab a lander link for a Meta ad.

## What it shows
Reads [[../tables/advertorial_pages]] for the workspace (one row per product × angle × variant) and renders a table: **product · type (Advertorial / Before-After) · headline · URL** (with a copy button).

## URL construction (in-house storefront only)
URLs are built on the **in-house storefront domain** (`workspaces.storefront_domain`, e.g. `shop.superfoodscompany.com`), NOT the Shopify store (`superfoodscompany.com/products/...` — that domain has no lander code):

```
https://{storefront_domain}/{product.handle}?variant={advertorial|beforeafter}&angle={slug}
```

Before/after rows use the `{base-slug}-ba` slug (variant + slug both filter the read). Fallback when there's no custom domain: `https://shopcx.ai/store/{storefront_slug}/{handle}?...`.

## Wiring
- Page: `src/app/dashboard/marketing/landers/page.tsx` (client; `useWorkspace` → `GET /api/ads/landers`).
- API: `src/app/api/ads/landers/route.ts` (owner/admin; joins `advertorial_pages` + `products.handle` + `workspaces.storefront_domain`).
- Sidebar: under **Marketing** (`src/app/dashboard/sidebar.tsx`), between Ads and Social.

## Related
[[../lifecycles/advertorial-landers]] · [[../tables/advertorial_pages]] · [[../ad-creative-rules]]
