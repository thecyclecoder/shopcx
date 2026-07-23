# libraries/bundle-fulfillment

Checkout-time remap of a **bundle marker** line to a real, fulfillable variant.

**File:** `src/lib/bundle-fulfillment.ts`

## Why

A bundle product (e.g. the Amazing Coffee **Starter Kit**) sells through a marker
variant — `products.bundle_variant_id`, SKU `SF-STARTER-KIT` — that anchors the
bundle OFFER (free-gift `included` items, see [[cart-gifts]] / [[offers]]) and the
bundle coupon (`STARTERKIT10`). That marker variant is **not stocked at the 3PL**:
Amplifier rejects it as `Unknown SKU`, so a first order whose paid line is the
marker fails to import and never ships (the SHOPCX74 bug).

The marker must stay on the **cart** line — offers are keyed on the paid anchor
variant and [[cart-gifts]] `ensureCartAttachments` re-derives on every cart
mutation, so swapping it in the cart would drop the gifts. So the remap happens at
**checkout**, when the order + subscription line items are written, DOWNSTREAM of
offer attachment.

## Exports

### `remapBundleLinesToBase(lines, bundleToBase)` — pure core

Given a `bundleVariantId → BaseVariantTarget` map, swaps each **paid** line
(never a `is_gift` or `offer_source_variant_id` line) whose `variant_id` is a
bundle marker to that bundle's base variant — rewriting `variant_id` / `sku` /
`variant_title` / `product_id` (and filling `image_url` only if absent), while
preserving the line's price + quantity. Unit-tested in `bundle-fulfillment.test.ts`.

### `resolveBundleFulfillmentLines(workspaceId, lines)` — DB wrapper

Finds which paid-line variants are a `products.bundle_variant_id`; for each such
product resolves the **base variant** (lowest `position` variant that is NOT the
marker), builds the map, and calls the pure core. No-op when the cart has no
bundle-marker lines. Behavior: Starter Kit always fulfills as the base coffee
(Cocoa French Roast). (CEO 2026-07-23.)

## Callers

- `src/app/api/checkout/route.ts` — remaps `cart.line_items` right after load, so
  the order + subscription both carry the fulfillable SKU while the 3PL submit
  ([[integrations__amplifier]]) gets a known SKU.

## Gotchas

- **Runs AFTER cart offer attachment, never in the cart.** Remapping in
  [[portal__mutation-guard]]'s sibling cart path would strip the bundle gifts on
  the next cart mutation (offers re-derive off the paid anchor variant).
- **Price is preserved** — the customer keeps the quoted bundle price; only the
  fulfillable identity changes.
- Pairs with [[integrations__amplifier]]'s `applyVariantSkus` (SKU is always
  re-resolved from the variant table at the 3PL chokepoint).

---

[[../README]] · [[../../CLAUDE]]
