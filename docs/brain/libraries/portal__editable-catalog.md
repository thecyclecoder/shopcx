# libraries/portal/editable-catalog

The ONE place that decides which products/variants a customer may swap or add INTO a
subscription — for BOTH the Portal and the next-order journey. Extracted so the two
surfaces stay in sync (CEO parity rule, 2026-11-22): cancels, saves and account
management exist on the Portal AND in journeys and must not diverge.

**File:** `src/lib/portal/editable-catalog.ts`

## Why it exists

The journey used to load every `products` row (including Shipping Protection,
out-of-stock and suppressed variants) while the Portal applied a stack of filters in
its bootstrap handler — the two had diverged. Worse, the Portal's out-of-stock filter
was `inventory_quantity == null || inventory_quantity > 0`, and
`product_variants.inventory_quantity` is **retired and always NULL**
([[../tables/product_variants]]), so that filter passed EVERYTHING — exactly how
out-of-stock variants (Strawberry Lemonade Tabs, Cocoa Instant Coffee) leaked into the
swap list. In-stock is now proven by canonical storefront on-hand
(`src/lib/inventory/read.ts` `getShopifyOnHandByVariant`, from [[../tables/inventory_levels]]).

## Exports

### `isSwappableConsumable(product, variant)` — pure predicate

May a customer swap/add INTO this (product, variant)? `true` only when the variant is
in stock (`onHand > 0`) AND the product is a real consumable. Rejects:

- **Shipping Protection** — `product_type='ShopWill'` / handle `shipping-insurance` /
  title keyword.
- **Free-gift duplicates** — the three product ids in `SHOPIFY_PRODUCT_ALIASES`
  (`src/lib/shopify-review-metafields.ts`) + the `(Free Gift)` title.
- **Internal Mystery Item** — by title.
- **Digital goods** — `product_type` digital / gift-card handle / title.

Pure (no I/O) so the failing state ("Cocoa Instant Coffee with on-hand 0 is rejected")
is unit-testable — see `src/lib/portal/editable-catalog.test.ts` (`npm run test:editable-catalog`).

### `loadEditableCatalog(workspaceId, admin?)` — `Promise<EditableCatalog>`

Builds the shared swap/add list: limited to `portal_config.general.products_available_to_add`,
Shipping Protection excluded by configured id (`shipping_protection_product_ids`),
suppressed variants dropped ([[portal__mutation-guard]] `getSuppressedVariantIds`), and
every remaining (product, variant) passed through `isSwappableConsumable`. Returns
`{ products, shippingProtectionProductIds, shippingProtectionVariantIds }`. Each product
preserves the raw JSONB variant object so the Portal client keeps its shape.

**Callers:** [[portal__handlers__bootstrap]] (Portal swap/add catalog) and
`src/lib/next-order-journey-builder.ts` (journey catalog).

### `assertSwappableConsumable(workspaceId, variantIds, admin?)` — server-side gate

Resolves each target variant → its product + canonical on-hand and applies
`isSwappableConsumable`, so a crafted request naming an out-of-stock / Shipping-Protection
/ free-gift / mystery / digital variant is rejected no matter what the UI showed. Returns
`{ ok: true }` or `{ ok: false, blocked }`. An unknown variant (not in the catalog) is
blocked. Enforced on BOTH surfaces: [[portal__handlers__replace-variants]] (next to
`assertNewVariantsSelectable`) and the journey edit route (`runPortalParityGuards`).

## Gotchas

- `onHand` keys on the Shopify variant id (the `id` in the `products.variants` JSONB and
  in `inventory_levels` for `location='shopify'`). The `shopify` figure is the storefront
  BUY GATE, not the 3PL ship truth — see [[../tables/inventory_levels]].
- SP products are excluded by **configured id** in `loadEditableCatalog`; the title-keyword
  check in `isSwappableConsumable` is a backstop, not the primary bar.

## See also

- [[../journeys/next-order]] · [[portal__handlers__bootstrap]] · [[portal__mutation-guard]] · [[subscription-frequency]]
