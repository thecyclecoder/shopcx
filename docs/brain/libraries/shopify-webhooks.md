# libraries/shopify-webhooks

Customer + order webhook handlers. Address fallback chain, customers/merge auto-link, orders/create → fraud detection trigger.

**File:** `src/lib/shopify-webhooks.ts`

## Exports

### `verifyShopifyWebhook` — function

```ts
async function verifyShopifyWebhook(body: string, hmacHeader: string, workspaceId: string) : Promise<boolean>
```

### `handleDisputeEvent` — function

```ts
async function handleDisputeEvent(workspaceId: string, payload: Record<string, unknown>, topic: string)
```

### `handleCustomerUpdate` — function

```ts
async function handleCustomerUpdate(workspaceId: string, payload: Record<string, unknown>)
```

### `handleOrderEvent` — function

```ts
async function handleOrderEvent(workspaceId: string, payload: Record<string, unknown>)
```

### `handleFulfillmentUpdate` — function

```ts
async function handleFulfillmentUpdate(workspaceId: string, payload: Record<string, unknown>)
```

## Callers

- `src/app/api/webhooks/shopify-returns/route.ts`
- `src/app/api/webhooks/shopify/route.ts`

## Gotchas

- **`handleOrderEvent` seeds the checkout-breakdown in `payment_details` (Phase 2 of [[../specs/shopify-order-confirmation-emails]]).** On every orders/create + orders/update it writes `{ subtotal_cents, tax_cents, shipping_cents, discount_cents }` into `orders.payment_details`, MERGED with the row's existing value (`{ ...existingPd, …new fields }`) — the fraud-detector's card fingerprint (`gateway`, `card_bin`, …) lives in the same column and MUST NOT be clobbered on the update-refire path. `shipping_cents` prefers the sum of `payload.shipping_lines[].price` and falls back to `payload.total_shipping_price_set.shop_money.amount` when the array is empty. See [[../tables/orders]] `payment_details` gotcha.
- **`handleOrderEvent` line items are simplified — but now carry `variant_title` + `total_discount_cents` + `product_id`** so the [[order-confirmation-data]] resolver renders the confirmation email straight from the row (no Shopify GraphQL round-trip on the fast path). The stored per-line shape is `{ title, quantity, price_cents, sku, variant_id, variant_title, total_discount_cents, product_id }`. Callers still join on `variant_id` (Shopify id) → `product_variants.shopify_variant_id` for the UUID + image.

---

[[../README]] · [[../../CLAUDE]]
