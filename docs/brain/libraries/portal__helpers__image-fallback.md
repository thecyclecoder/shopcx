# libraries/portal/helpers/image-fallback

Portal product image fallback URL.

**File:** `src/lib/portal/helpers/image-fallback.ts`

## File header

```
Hydrate `image_url` on subscription + order line items.
Image priority on each item:
1. product_variants.image_url — canonical UUID rows. Storefront
overrides win here; otherwise the row carries the
Shopify-synced variant image. Matched by internal_id,
shopify_variant_id, sku, or title.
2. products.variants[].image_url — legacy JSONB mirror.
3. products.image_url — Shopify product hero (final fallback).
4. item.image_url already stamped on the row (safety net).
Two index paths so we work for both subscription items (have
product_id) and order line items (often have only variant_id):
- Direct: variant_id → image_url, sourced from product_variants
(resolves orders that don't carry product_id)
- Indirect: product_id → byKey map, used when product_id is set
Server-side only — designed for SSR enrichment in
/portal/[slug]/page.tsx and /portal/[slug]/subscriptions/[id]/page.tsx.
```

## Exports

_No public exports found._

## Callers

- `src/app/portal/[slug]/page.tsx`
- `src/app/portal/[slug]/subscriptions/[id]/page.tsx`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
