# libraries/product-variants

First-class variant helpers: `getProductVariants()`, `findVariant()`, `getVariantIndex()`. Internal UUID-keyed; never use Shopify variant id for joins.

**File:** `src/lib/product-variants.ts`

## File header

```
Variant access layer.
Source of truth is the `product_variants` table (UUID-keyed). The legacy
`products.variants` JSONB column is mirrored on every sync and stamped
with `internal_id` per element so consumers reading the JSONB still pick
up the UUID — but new code should read here.
Once we move off Shopify, the JSONB mirror gets dropped.
```

## Exports

### `getProductVariants` — function

```ts
async function getProductVariants(productId: string) : Promise<ProductVariant[]>
```

### `findVariant` — function

```ts
async function findVariant(workspaceId: string, ref: { id?: string; shopifyVariantId?: string; sku?: string },) : Promise<ProductVariant | null>
```

### `getVariantIndex` — function

```ts
async function getVariantIndex(workspaceId: string) : Promise<
```

### `resolveShopifyVariantId` — function

```ts
async function resolveShopifyVariantId(workspaceId: string, ref: string | number | null | undefined): Promise<string | null>
```

Resolve an incoming variant reference to the numeric Shopify variant id the Shopify draft-order API expects (it wraps the value in `gid://shopify/ProductVariant/<id>`). Accepts either a numeric Shopify id (passthrough) or our internal `product_variants.id` UUID (workspace-scoped lookup of `shopify_variant_id`). Returns `null` for an empty/unknown-shape ref, a UUID with no matching workspace row, or an internal-only variant with a null `shopify_variant_id`.

Called by the two draft-order boundaries — [[replacement-order]] `createReplacementOrder` and [[shopify-draft-orders]] `createReplacementDraftOrder` — so an internally-billed renewal (SHOPCX*, `shopify_order_id` NULL) whose line items carry `product_variants.id` UUIDs surfaces a specific error at the boundary instead of Shopify's opaque "Product with ID X is no longer available". Ground-truth ticket `1aea6114-7417-421f-99d0-05cce22f2ff6` (SHOPCX272 — the internal-order replacement that couldn't remediate). See [[../specs/replacements-must-work-for-internal-non-shopify-renewal-orders]].

### `ProductVariant` — interface

## Callers

- `src/app/api/cart/route.ts`
- `src/lib/cart-gifts.ts`
- `src/lib/replacement-order.ts` — `createReplacementOrder` normalises UUID → shopify id via `resolveShopifyVariantId` before the draft build.
- `src/lib/shopify-draft-orders.ts` — `createReplacementDraftOrder` does the same before building the GID.

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
