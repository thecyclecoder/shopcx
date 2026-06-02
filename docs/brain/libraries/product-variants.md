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

### `ProductVariant` — interface

## Callers

- `src/app/api/cart/route.ts`
- `src/lib/cart-gifts.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
