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

### Persist-to-renewal offer overlay

When the sub carries `pricing_offer_id` ([[../tables/subscriptions]] → [[../tables/pricing_rule_offers]]), the engine loads that offer and — only when it is `status='active'` and `now() ∈ [starts_at, ends_at]` — overlays it on that offer's `product_id` lines: `renewal_price_cents` pins the per-unit charge outright, else `subscribe_discount_pct` **overrides** the resolved S&S % (break still applies). Out-of-scope lines + subs with no / expired / un-approved offer get untouched base rule pricing. Because the sub stores a **reference, not a baked price**, expiring the offer reverts it automatically — the same reversibility the engine relies on everywhere. An applied offer adds a `renewal_offer` discount pill (labelled "Renewal Offer"). This is the M6 lever's read path; nothing populates `pricing_offer_id` until the deferred `storefront-renewal-offer-lever` ships, so the path is dormant by default. Spec: `storefront-dynamic-renewal-offers.md`.

Pricing data lives in [[../tables/pricing_rules]] (linked to products via [[../tables/product_pricing_rule]]): `quantity_breaks`, `subscribe_discount_pct`, `free_shipping`. Free shipping mirrors the storefront's authoritative rule — `free_shipping && (!free_shipping_subscription_only || isSubscribing)`. Internal subs are **always** subscription-mode, so a rule with `free_shipping = true` grants it outright; `free_shipping_threshold_cents` does **not** gate the decision (it's a one-time-order / banner concept).

## Identifier discipline

Items reference the **variant UUID** (`product_variants.id`), never the Shopify variant id. The engine resolves variants by id-shape (UUID → `id`, numeric → `shopify_variant_id`) and keys its lookup map by **both**, so legacy items that still hold a Shopify id keep working during the transition. New writes ([[internal-subscription]] mutations, [[migrate-to-internal]]) always store the UUID.

## Classification

- **product** — catalog item with a rule → break × S&S. Counts toward `product_subtotal_cents` (the discountable base for coupons).
- **protection** — billed/displayed from the sub's `shipping_protection_added` + `_amount_cents` **columns** (the renewal + engine read the column), so it's excluded from the product subtotal. For **internal** subs the portal toggle is column-based (`route=shippingProtection`) — NOT a line item — so the toggle, the order summary, and billing share one source of truth. (Appstle subs keep the line-item add/remove flow.) A protection *item* in `items` is legacy and gets excluded from the subtotal by title match.
- **gift** — `is_gift` → $0. (Free gifts are a storefront concern, passthrough here.)

## Display layer — `commerce/price.ts`

`priceSubscription(workspaceId, sub)` is the shape-agnostic core for **every display surface** (portal, mini-site, dashboard, ticket detail, AI stack): it returns a per-line `{ base_cents, unit_cents }` map (keyed by line_id + variant_id) and an order-level summary (`subtotal / discount / shipping / protection / total / free_shipping / pills`). It runs the engine for internal subs and uses the baked item prices for Appstle subs. Lives at `src/lib/commerce/price.ts` — moved from `portal/helpers/enrich-pricing.ts` by [[../specs/commerce-sdk-scaffold-money-resolver]] Phase 2; the old path is now a deprecated re-export shim.

**Money invariant.** If either branch would yield an `undefined` / `NaN` `base_cents` or `unit_cents` on a real product line, `priceSubscription` throws `PriceInvariantError` (exported alongside) with the sub id + line id in the message — so no display surface can silently render `$NaN` / `$0` / undefined. Gifts (unit $0) + shipping-protection lines are expected zeros and pass. Repro: `npx tsx scripts/_probe-price-invariant.ts`.

Consumers:
- `enrichContractPricing(...)` — API-handler wrapper; writes `currentPrice` + `basePrice` onto `contract.lines`. Used by [[portal__handlers__subscriptions]] (list) and [[portal__handlers__subscription-detail]].
- `page.tsx` (mini-site server render) calls `priceSubscription` directly and maps onto `PortalSubscription.items[].{price_cents, base_price_cents}` + `pricing`. **The mini-site list paints from page.tsx, not the API handler — both paths must price.**

**Discount pills** (`pricing.discounts`): `{kind, label}` — `25% Subscribe & Save`, `8% OFF Buy 2` (active quantity-break tier), `Free Shipping`, plus a `coupon` pill appended from `applied_discounts`. Pills render in a row under the per-delivery total on **both** the list card and the detail header, and **re-derive on mutation** — the detail screen reloads from the list endpoint after every action, so swapping a product or changing quantity updates the tier (e.g. Buy 2 → Buy 3).

**Coupon card (one coupon per sub):** the detail screen's Coupon card reads `appliedDiscounts` (surfaced by the list handler in both shapes). When a coupon is live it shows it with a **Remove** button and hides the apply input — the customer must remove the current coupon before applying a different one. Remove sends both `discountId` (Appstle) and `discountCode` (internal coupons have no id).

**Add/Swap modal price** (`route=priceQuote`): previews a line's price on an internal sub by running the engine on a *projected* (non-persisted) items array — so the modal shows the real mix-and-match quantity-break + S&S (you can't compute the mix-and-match tier from a single variant client-side). Appstle subs return `internal:false` and keep the client estimate.

**Order summary breakdown** (detail page, `OrderSummaryCard`): MSRP strikethrough → subtotal (+ rule discount %) → coupon → shipping (Free) → protection → **estimated tax** → all-in total. Tax comes from `route=subscriptionTax` → `ensureFreshSubscriptionTaxQuote`, **saved to the sub** (`avalara_quote_*`). `quoteSubscriptionTax` prices through the engine (the sub's items carry no baked price), matching the renewal — tax on the pre-coupon engine subtotal, same as billing.

**Tax freshness = input hash, NOT `updated_at`.** `ensureFreshSubscriptionTaxQuote` returns the cached quote only when the sub's current tax inputs still hash to the stored `avalara_quote_hash` (`hashTaxInputs` over engine-priced lines + shipping + protection + ship-to). Why not `updated_at`: under **dynamic pricing** a catalog price change or a pricing-rule edit re-prices the sub **without touching the row**, so `updated_at` wouldn't move and a stale quote would be served. The hash changes whenever any tax-determining input changes — a sub mutation OR a catalog/rule edit — so it can't go stale, and it also avoids re-quoting on a spurious `updated_at` bump. Billing never relies on the cached quote (the renewal does its own commit=true call), so even a stale display quote can't mischarge.

**Coupon normalization:** `applied_discounts` comes in two shapes — the internal coupon engine's `{ type: "percentage"|"fixed_amount", value }` and the Appstle-synced `{ valueType: "PERCENTAGE"|"FIXED_AMOUNT", value }`. The display layer handles both (read-only, no cycle consumption) so an Appstle sub's coupon shows in its total. Billing uses the authoritative [[coupons]] `computeAppliedDiscountCents` (internal shape only) — Appstle coupons are charged by Appstle.

## Gotchas

- **Never bake a price on an internal sub item.** A baked `price_cents` is legacy; the engine reads it only as a fallback when a variant isn't in the catalog (so nothing prices to $0 mid-rollout). Item mutations strip it.
- **Double-discount trap (fixed 2026-06):** if a variant isn't found in the catalog, `base` falls back to the item's baked price — which is already post-discount — then S&S applies again. The cause was a variant stored as a Shopify id while the engine only looked up by `shopify_variant_id`. The dual-shape resolver closes this; the real fix is items storing the UUID.

---

[[../README]] · [[../lifecycles/subscription-billing]] · [[../lifecycles/customer-portal]]
