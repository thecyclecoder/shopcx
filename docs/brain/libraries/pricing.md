# pricing.ts — internal-subscription pricing engine

`src/lib/pricing.ts` · the single source of truth for what an **internal** subscription costs. Called by both the portal display ([[portal__handlers__subscription-detail]]) and the renewal scheduler ([[../inngest/internal-subscription-renewals]]). **Internal subs only** — Appstle subs carry pricing baked by Appstle/Shopify and must never run through here.

## The principle

A subscription stores catalog **references**, not prices. The only price an internal sub row may carry is a **grandfathered override** (`items[].price_override_cents`). Everything else is derived live, so a catalog price change or a rule edit flows through automatically — nothing is hard-baked into the row. (Orders are the exception: an order is a historical record, so the renewal snapshots the engine's prices onto the order's line items.)

## Export

```ts
resolveSubscriptionPricing(workspaceId, sub): Promise<SubscriptionPricing>
// sub must include `items` and `delivery_price_cents`.
```

Returns per-line `{ base_cents (strikethrough), unit_cents (charged), break_pct, sns_pct, kind, is_grandfathered }` plus `product_subtotal_cents`, `product_msrp_cents`, `shipping_cents`, `free_shipping`.

## The rules (per line, multiplicative)

```
base   = price_override_cents (grandfathered) ?? catalog product_variants.price_cents
break% = quantity-break tier for the MIX-AND-MATCH total quantity of all lines
         sharing the line's pricing rule (2 flavors on the same rule → the qty-2 tier)
sns%   = pricing_rule.subscribe_discount_pct, else workspaces.subscription_discount_pct
unit   = round(base × (1 − break%/100) × (1 − sns%/100))
```

Pricing data lives in [[../tables/pricing_rules]] (linked to products via [[../tables/product_pricing_rule]]): `quantity_breaks`, `subscribe_discount_pct`, `free_shipping`. Free shipping mirrors the storefront's authoritative rule — `free_shipping && (!free_shipping_subscription_only || isSubscribing)`. Internal subs are **always** subscription-mode, so a rule with `free_shipping = true` grants it outright; `free_shipping_threshold_cents` does **not** gate the decision (it's a one-time-order / banner concept).

## Identifier discipline

Items reference the **variant UUID** (`product_variants.id`), never the Shopify variant id. The engine resolves variants by id-shape (UUID → `id`, numeric → `shopify_variant_id`) and keys its lookup map by **both**, so legacy items that still hold a Shopify id keep working during the transition. New writes ([[internal-subscription]] mutations, [[migrate-to-internal]]) always store the UUID.

## Classification

- **product** — catalog item with a rule → break × S&S. Counts toward `product_subtotal_cents` (the discountable base for coupons).
- **protection** — "Shipping Protection" line → passthrough (its stored price, no discount). Billed via the sub's `shipping_protection_*` columns, so excluded from the product subtotal.
- **gift** — `is_gift` → $0. (Free gifts are a storefront concern, passthrough here.)

## Gotchas

- **Never bake a price on an internal sub item.** A baked `price_cents` is legacy; the engine reads it only as a fallback when a variant isn't in the catalog (so nothing prices to $0 mid-rollout). Item mutations strip it.
- **Double-discount trap (fixed 2026-06):** if a variant isn't found in the catalog, `base` falls back to the item's baked price — which is already post-discount — then S&S applies again. The cause was a variant stored as a Shopify id while the engine only looked up by `shopify_variant_id`. The dual-shape resolver closes this; the real fix is items storing the UUID.

---

[[../README]] · [[../lifecycles/subscription-billing]] · [[../lifecycles/customer-portal]]
