# libraries/review-request-cx-surface

Pure CX-surface derivation the post-order review-ask composer keys personalization off — the `first-time` vs `repeat` window signal + the tenure fact, both derived from the customer's actual order + subscription history across ALL linked identities. Never from `customers.created_at`.

**File:** `src/lib/review-request-cx-surface.ts`

## Why this module exists

Ticket `7e3ee827-7297-4229-be57-7c86c80214a0` — an ~8-month repeat Amazing Coffee subscriber across 3 contracts (1 active Cocoa x3, 2 cancelled) received a post-order review ask that said "You tried Amazing Coffee for the first time" and "you've been with us about 5 months". Both were fabricated. The two root causes:

1. **Detector was linked-identity-blind + subscription-blind.** [[../inngest/post-order-review-ask-detector-cron]] `classifyPostOrderWindow` only scanned `orders.line_items` for the anchor `customer_id`. Joanne's earlier Amazing Coffee purchases sat on OTHER linked `customer_id`s AND inside subscription contracts the detector never opened, so her anchor order looked first-time.
2. **Tenure was sourced from `customer.created_at`.** [[review-request-sender]] fed `tenureDays = (now - customer.created_at)` — her account creation, not her earliest observable activity. Her account was 5 months old; her earliest AC order was 8 months old.

The fix is a single pure derivation this module owns: merge the surface across linked customer ids, pull every order (`line_items`) + every subscription (`items`, active OR cancelled), and answer two questions:

- **Did the customer buy THIS product before?** ⇒ `window='repeat'` on any hit.
- **What is their earliest observed activity?** ⇒ `tenureDays` from that timestamp.

When we cannot positively verify a claim (blind history, no observable activity), the module returns `null` and the composer falls back to a neutral opening that asserts nothing. That is the "withhold when unverifiable" contract this module makes explicit.

## Exports

### `deriveCxSurfacePersonalization({ orders, subscriptions, product, anchorOrderId, now })`

Pure derivation. Returns:

```
{
  window: 'first-time' | 'repeat' | null,   // null = withhold
  tenureDays: number | null,                 // null = withhold
  withheldReason: 'history_blind' | 'no_activity_observed' | null,
  surfaceShowsRepeat: boolean,               // positive evidence of prior purchase
}
```

Rules:

- `window='repeat'` — the surface positively shows a prior purchase of this product (any prior order line matches OR any subscription item matches).
- `window='first-time'` — the surface is FULLY VISIBLE (every prior order's line items are readable, no blind contracts) AND has no prior purchase of this product. Brand-new customers (zero prior orders + zero subs) also land here — nothing to be blind about.
- `window=null` — any prior order has entirely unreadable line items (`product_id` / `variant_id` / `sku` all absent). We cannot prove absence, so we cannot claim first-time. `withheldReason='history_blind'`.
- `tenureDays` — days between `now` and the earliest activity across every order's `created_at` + every subscription's `subscription_created_at` (falling back to `created_at`). `null` when no activity is observable.

### `personalizationContradictsSurface({ claim, proposedWindow })`

Boolean — does a proposed composer window CONTRADICT the derived surface? Only one case returns true: `proposedWindow='first-time'` while `claim.surfaceShowsRepeat === true`. Used by [[review-request-sender]] as a pre-send guard that THROWS rather than ship a contradicting claim — a defense-in-depth assertion if a future edit ever routes around the derivation.

### `ProductIdentityFingerprint`

The set of identifiers that all resolve to the SAME internal product — the `internalProductId` (UUID), the `shopifyProductId` (Shopify numeric string), the set of `product_variants.id` (UUIDs), `product_variants.shopify_variant_id`, and `product_variants.sku`. The membership check runs across all shapes so an order/sub that only knows one identifier resolves. Built once in the sender from [[../tables/products]] + [[../tables/product_variants]].

## The three line-item shapes it matches

Same product surfaces under different shapes across the app:

- **`orders.line_items` (Shopify webhook)** — `product_id` numeric string, `variant_id` numeric string, `sku` string. See [[../tables/orders]] § Gotchas.
- **`subscriptions.items` (Appstle)** — variant_id numeric string, sku.
- **`subscriptions.items` (internal)** — `product_id` UUID, `variant_id` UUID. See [[../tables/subscriptions]] § Gotchas.

The fingerprint check runs against ALL three so we never miss a prior purchase because of the id-shape it stored under.

## Callers

- [[review-request-sender]] `applyReviewRequest` — post-order branch only. The ticket-trigger opening never renders a tenure phrase, so it does not need the derivation. The sender does the DB probes (linked-ids expansion via the `resolve_customer_link_group` RPC + workspace-scoped orders/subs/product/variants reads) and hands the merged surface to this pure module.

## Pin tests

- [[../../src/lib/review-request-cx-surface.test.ts]] — pins every branch of the derivation with the Joanne shape as the primary fixture. Run: `npx tsx --test src/lib/review-request-cx-surface.test.ts`.
- [[review-request-compose]]'s test suite continues to pin the composer's copy shapes; the CX-surface module is the layer BETWEEN the detector and the composer.

## Related

- [[../inngest/post-order-review-ask-detector-cron]] — the upstream per-order classifier. Its `firstTimeKeys` set is what the sender's CX-surface derivation OVERRIDES when a linked-identity or subscription-side hit shows repeat.
- [[review-request-sender]] — where the DB probes live + where the pre-send contradiction guard fires.
- [[review-request-compose]] — the copy shapes the derivation feeds. `window=null` / `tenureDays=null` fall through to the composer's neutral opening.
- [[../tables/customer_links]] — the linked-identity graph the derivation merges over.

---

[[../README]] · [[../../CLAUDE]] · [[review-request-sender]] · [[review-request-compose]] · [[../inngest/post-order-review-ask-detector-cron]]
