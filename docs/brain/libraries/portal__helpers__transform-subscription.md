# libraries/portal/helpers/transform-subscription

Portal sub transform: DB row → portal-facing JSON.

**File:** `src/lib/portal/helpers/transform-subscription.ts`

## File header

```
Transform our DB subscription shape into the contract shape the portal frontend expects.
Bridges: DB (snake_case, items[], price_cents) → Frontend (camelCase, lines[], MoneyV2).

Image priority on each line item:
  1. product_variants.image_url — canonical UUID rows. Storefront
     overrides (admin upload) win here; otherwise this row carries
     the Shopify-synced variant image. Matched by internal_id,
     shopify_variant_id, sku, or variant_title.
  2. products.variants[].image_url — legacy JSONB mirror. Same data
     Shopify originally synced; used as a fallback when the
     canonical table doesn't have a hit.
  3. products.image_url — Shopify product hero. Final fallback only
     when no variant-level image exists anywhere.
  4. item.image_url — stamped at checkout for internal subs; safety
     net for cases where the catalog lookup can't resolve the
     product at all (e.g. variant rotated out of the catalog).
```

## Exports

### `transformSubscription` — function

```ts
function transformSubscription(sub: Record<string, unknown>, productMap: ProductMap = {})
```

### `getProductMap` — function

```ts
async function getProductMap(admin: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>, workspaceId: string, productIds: string[], variantIds: string[] = [],) : Promise<ProductMap>
```

## Callers

- `src/lib/portal/handlers/subscription-detail.ts`
- `src/lib/portal/handlers/subscriptions.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
