# inngest/order-confirmation

Async job: on `order/confirmation.requested` (fired from `src/lib/shopify-webhooks.ts` at the end of every newly-seen + paid `orders/create` webhook), resolve the [[../libraries/order-confirmation-data]] payload for the Shopify order and send exactly one order-confirmation email via [[../libraries/email-storefront]] `sendOrderConfirmationEmail`. Idempotent per order via `orders.order_confirmation_email_id` — the pre-dispatch guard reads that column before the send, and on success stamps the Resend id + `order_confirmation_sent_at` under a compare-and-set on `IS NULL` so a concurrent invocation can't overwrite the first stamp. Phase 4 of [[../specs/shopify-order-confirmation-emails]] — the first of the transactional sends we're reclaiming from the sunset Klaviyo.

**File:** `src/lib/inngest/order-confirmation.ts`

## Functions

### `order-confirmation-send`
- **Trigger:** event `order/confirmation.requested` · fired from `src/lib/shopify-webhooks.ts` at the end of every newly-seen + paid `orders/create` webhook (mirror of the fraud/demographics fire-and-forget pattern, line ~747). Payload: `{ workspaceId, orderId }`.
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 5, key: "event.data.workspaceId" }]` — cap per-workspace parallel sends so one workspace's renewal burst can't starve others.
- **Throttle:** `throttle: { limit: 8, period: "1s" }` — kept just under Resend's ~10 req/s ceiling so retries have headroom.

Handler shape:

1. **Load the order** — [[../tables/orders]] row scoped to `(workspace_id, id)`, selecting the Phase-1 `ORDER_EMAIL_ROW_COLS` union plus `tags`, `financial_status`, and `order_confirmation_email_id` for the guards.
2. **Skip guards** — return `{ skipped: <reason> }` (no throw, no retry) when:
   - `order_not_found` — the row was deleted between event fire and this run.
   - `not_shopify_order` — `shopify_order_id` is null (only Shopify-sourced orders belong here; the internal-checkout path already sends inline).
   - `already_sent` — `order_confirmation_email_id` is non-null. Returns the stored Resend id so a re-fire is observably a no-op.
   - `not_paid` — `financial_status !== 'paid'`. Defence in depth; the enqueuer also gates.
   - `missing_email` — no address to send to.
   - `wholesale_or_test` — `tags` (comma-separated Shopify string) contains "wholesale" or "test" case-insensitive.
3. **Resolve** the `OrderForEmail` payload + send inputs via [[../libraries/order-confirmation-data]] `getShopifyOrderEmailData`. The resolver merges (a) stored webhook fields, (b) `product_variants` join for image + product_id + variant title, and (c) best-effort Shopify GraphQL backfill for totals + variantTitle + compareAtPrice.
4. **Send** via [[../libraries/email-storefront]] `sendOrderConfirmationEmail`. Phase-3 return shape `{ success, error?, resendEmailId? }` — a resend-not-configured or blocked recipient is a non-fatal skip; anything else throws so Inngest retries under the throttle policy.
5. **Stamp the tracking columns** — update [[../tables/orders]] `order_confirmation_email_id` + `order_confirmation_sent_at` under `WHERE order_confirmation_email_id IS NULL` (compare-and-set), and insert a matching [[../tables/email_events]] row (`event_type='sent'`, `order_id` FK) so `/api/webhooks/resend-events` can attach delivered/opened for this send.

## Downstream events sent

_None._ (Leaf function — sends the email, stamps the tracking, writes the `email_events` mirror.)

## Upstream events consumed

- `order/confirmation.requested` — enqueued by [[../libraries/shopify-webhooks]] `handleOrderEvent` at the end of every newly-seen + paid `orders/create` upsert, in the fire-and-forget `inngest.send(...).catch(() => {})` pattern that mirrors the fraud-check + demographics enqueues in the same block.

## Tables written

- [[../tables/orders]] — stamp `order_confirmation_email_id` + `order_confirmation_sent_at` (the Phase-3 tracking columns).
- [[../tables/email_events]] — mirror the send as `event_type='sent'` so the resend-events pipeline picks up delivered/opened for this order.

## Tables read (not written)

- [[../tables/orders]] — load the order row for the guards + resolver.
- [[../tables/product_variants]] / [[../tables/products]] / [[../tables/subscriptions]] / [[../tables/workspaces]] — read inside the resolver / send helpers; see [[../libraries/order-confirmation-data]] + [[../libraries/email-storefront]].

## Idempotency layers

1. **Pre-dispatch column guard** — `orders.order_confirmation_email_id` non-null → skip. The dedupe key for a webhook retry that fires the event again.
2. **Compare-and-set stamp** — the stamp update filters `WHERE order_confirmation_email_id IS NULL`, so two runs that race past the guard read both try to stamp but only one persists.
3. **Inngest step ids** — a retry inside the same run cannot re-execute a completed step (`send-email` / `stamp-confirmation-tracking`).

## Flood safety

Concurrency caps parallel sends per workspace at 5; throttle caps total send-starts at 8/s (well under Resend's ~10 req/s). The daily subscription-renewal burst (50–100 orders/create webhooks fired by Shopify within minutes of the Appstle recurring charge) is smoothed across seconds instead of arriving in one Resend spike.

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/email-storefront]] · [[../libraries/order-confirmation-data]] · [[../libraries/shopify-webhooks]] · [[../tables/orders]] · [[../tables/email_events]] · [[../specs/shopify-order-confirmation-emails]] · [[../../CLAUDE]]
