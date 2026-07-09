# libraries/order-confirmation-data

Resolver that assembles the `OrderForEmail` payload [[email-storefront]] `sendOrderConfirmationEmail` needs for a synced Shopify order. Introduced by [[../specs/shopify-order-confirmation-emails]] Phase 1 — the Klaviyo replacement for order-confirmation sends.

**File:** `src/lib/order-confirmation-data.ts`

## Purpose

Three-source merge:

1. **`orders` row (webhook-stored).** Prefers `payment_details.{subtotal_cents,shipping_cents,tax_cents}` when present. Phase 2 will make this the common path; today it's rare (older webhook writes never captured them and subscription-renewal rows have `payment_details=null`).
2. **`product_variants` join.** Batches `line_items[].variant_id` → `product_variants.shopify_variant_id` for `image_url` + `product_id` + `title`. Falls back to the parent [[../tables/products]]`.image_url` when the variant has none.
3. **Shopify GraphQL `order(id:)`.** Best-effort backfill for the totals + per-line `variantTitle` / `compareAtPrice` that the row doesn't carry. Uses `getShopifyCredentials` + [[shopify]]`.SHOPIFY_API_VERSION`, mirroring [[fraud-detector]] § billing-backfill.

GraphQL is best-effort — on failure the resolver still returns with stored totals plus a line-item subtotal fallback (the email template degrades gracefully: gray image box, no strikethrough).

## Exports

### `getShopifyOrderEmailData(order)` — function

```ts
async function getShopifyOrderEmailData(order: OrderRow): Promise<OrderConfirmationData>
```

`OrderRow` = the columns listed in `ORDER_EMAIL_ROW_COLS`. Callers that already hold the `orders` row (Phase 4 sender, verification script) should call this directly. Never mutates.

Returns:

```ts
type OrderConfirmationData = {
  order: OrderForEmail;         // ready to hand to sendOrderConfirmationEmail
  isFirstOrder: boolean;        // same query as /api/checkout/route.ts:1174
  subscribing: boolean;         // !!order.subscription_id
  nextBillingDate: string | null;
  usedGraphQL: boolean;         // false = stored-only fast path (Phase 2 verifies this)
};
```

### `getShopifyOrderEmailDataById(workspaceId, orderId)` — function

Loader convenience — reads the row by id then delegates to `getShopifyOrderEmailData`. Used by the verification script.

### `ORDER_EMAIL_ROW_COLS` — const

The exact `orders` column list the resolver reads (`id, workspace_id, customer_id, shopify_order_id, order_number, email, total_cents, line_items, shipping_address, shipping_method_code, payment_details, subscription_id, shipping_protection_added, shipping_protection_amount_cents, source_name, amplifier_tracking_number, amplifier_carrier`). Callers should `select` these — no more, no less.

## Callers

- `scripts/_verify-order-confirmation-data.ts` — Phase-1 verification (web / subscription renewal / other-source).
- Phase 4 will add `src/lib/inngest/order-confirmation.ts` (queued sender) — pending.

## Gotchas

- **`line_items` is JSONB, not a join.** The resolver reads the stored simplified shape (`title / quantity / price_cents / sku / variant_id`, plus Phase 2's forthcoming `variant_title / product_id / total_discount_cents`) — see [[../tables/orders]] gotchas.
- **Money is in shop currency.** The GraphQL fetch requests `shopMoney` (not `presentmentMoney`), matching the stored `orders.total_cents` which came off `total_price` in the same currency.
- **`shopify_order_id` is a numeric string** — the fetch handles both bare id and GID form (`gid://shopify/Order/...`). Internal joins on `orders` still use UUID `id`.
- **`isFirstOrder`** uses a simple `.eq(workspace_id).eq(customer_id).neq(id).count(head:true)` — matches `/api/checkout/route.ts:1174`. No `customer_id` on the row → treated as first.
- **Batch variant lookup** is `.in("shopify_variant_id", …)` in a single query (68/68 hit on real data). Missing image falls back to `products.image_url`; if neither has one the template renders a gray box (no send failure).
- **Best-effort GraphQL.** A GraphQL failure logs a warning and continues; the `usedGraphQL` flag on the return lets Phase 2's verification log-assert the stored-only fast path.

---

[[../README]] · [[../../CLAUDE]]
