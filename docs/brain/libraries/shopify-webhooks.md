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

- **`handleDisputeEvent` upserts on `disputes/update` when the dispute is unknown, instead of dropping the webhook.** Shopify only guarantees delivery for events after webhook registration, so a `disputes/update` for a dispute we never saw a `disputes/create` for is normal (dispute opened before the merchant registered our webhooks, or a transient miss on create). When `existing` is null in the update branch, we INSERT a new `chargeback_events` row using the same field mapping as the create branch (workspace_id, shopify_dispute_id, shopify_order_id, dispute_type, reason, network_reason_code, amount_cents, currency, status, evidence_due_by, evidence_sent_on, finalized_on, raw_payload, initiated_at) and, if the incoming `status` is terminal (`won` | `lost`), fire `chargeback/won` / `chargeback/lost` on Inngest with the new row's id — so downstream fan-out runs even when we first meet the dispute mid-lifecycle. The create branch's idempotency check (unique on `workspace_id + shopify_dispute_id`) prevents a duplicate row if both topics race.
- **`handleOrderEvent` seeds the checkout-breakdown in `payment_details` (Phase 2 of [[../specs/shopify-order-confirmation-emails]]).** On every orders/create + orders/update it writes `{ subtotal_cents, tax_cents, shipping_cents, discount_cents }` into `orders.payment_details`, MERGED with the row's existing value (`{ ...existingPd, …new fields }`) — the fraud-detector's card fingerprint (`gateway`, `card_bin`, …) lives in the same column and MUST NOT be clobbered on the update-refire path. `shipping_cents` prefers the sum of `payload.shipping_lines[].price` and falls back to `payload.total_shipping_price_set.shop_money.amount` when the array is empty. See [[../tables/orders]] `payment_details` gotcha.
- **`handleOrderEvent` line items are simplified — but now carry `variant_title` + `total_discount_cents` + `product_id`** so the [[order-confirmation-data]] resolver renders the confirmation email straight from the row (no Shopify GraphQL round-trip on the fast path). The stored per-line shape is `{ title, quantity, price_cents, sku, variant_id, variant_title, total_discount_cents, product_id }`. Callers still join on `variant_id` (Shopify id) → `product_variants.shopify_variant_id` for the UUID + image.

---

[[../README]] · [[../../CLAUDE]]
