# libraries/email-storefront

Storefront transactional emails (order confirmation, shipping notifications).

**File:** `src/lib/email-storefront.ts`

## File header

```
Storefront transactional emails:
- sendOrderConfirmationEmail  — fires from /api/checkout after a
successful order (separate from packing slip, which is printed
by Amplifier; this is the inbox copy)
- sendShippingNotificationEmail — fires from the Amplifier
order.shipped webhook once the warehouse hands the package to
the carrier and we have a tracking number
Both are best-effort: failure logs but never blocks the calling
pipeline (order creation succeeds even if the inbox email fails;
the customer can always read it on the dashboard).
```

## Exports

### `sendOrderConfirmationEmail` — function

```ts
async function sendOrderConfirmationEmail(opts: { workspaceId: string; order: OrderForEmail; isFirstOrder: boolean; subscribing: boolean; nextBillingDate?: string | null; /** Personal note from the founder — same message that prints on the * packing slip. Wraps in a styled blockquote with attribution. */ founderNote?: string | null; /** What the customer WOULD have paid for shipping had they checked * out as a one-time shopper. Used for the strikethrough → Free * treatment on subscribing orders. When omitted we don't show a * strikethrough. */ shippingValueCents?: number | null; }) : Promise<{ success: boolean; error?: string; resendEmailId?: string }>
```

**Return shape (Phase 3 of [[../specs/shopify-order-confirmation-emails]]).** On success returns `{ success: true, resendEmailId: <Resend id> }`. The Phase-4 queued sender stamps [[../tables/orders]] `order_confirmation_email_id` + `order_confirmation_sent_at` from `resendEmailId`, which doubles as the dedupe key. Also lets `/api/webhooks/resend-events` join delivered/opened back to the order via [[../tables/email_events]] `order_id`.

### `sendShippingNotificationEmail` — function

```ts
async function sendShippingNotificationEmail(opts: { workspaceId: string; order: OrderForEmail; }) : Promise<
```

### `sendAbandonedCartEmail` — function

```ts
async function sendAbandonedCartEmail(opts: { workspaceId: string; to: string; firstName?: string | null; cartToken: string; lineItems: AbandonedCartLine[]; subtotalCents: number; storefrontDomain: string | null; }) : Promise<
```

## Callers

- `src/lib/inngest/abandoned-cart.ts`

### `uuidLineItemProductIds` — function

```ts
export function uuidLineItemProductIds(ids: ReadonlyArray<string | null | undefined>): string[]
```

UUID-shape guard for the featured-review query. Both `sendOrderConfirmationEmail` and `sendShippingNotificationEmail` render a social-proof review sourced by `.in('product_id', productIds)` against `product_reviews`. Some line items carry a Shopify NUMERIC product id in `product_id` rather than the internal UUID — Shipping Protection is the confirmed case (its `product_id` is the Shopify id `7634377900205`; the row's real internal UUID lives at `products.shopify_product_id`). A single non-UUID value makes Postgres raise `22P02 invalid input syntax for type uuid` and errors the WHOLE query, silently dropping the review block for every valid product in the same order. This helper strips non-UUID ids before they reach the filter; it is applied at both build sites AND as defense-in-depth inside `pickFeaturedReview`. Same join-discipline invariant as the fraud order_ids / customer-fraud-status fixes: never mix Shopify ids into a UUID column filter.

## Gotchas

- **Non-UUID line-item `product_id` poisons the featured-review query.** `product_reviews.product_id` is a UUID column; a Shopify-numeric id (Shipping Protection = `7634377900205`) in the `.in(...)` array 22P02s the entire query. `uuidLineItemProductIds` is the guard — always run it before calling `pickFeaturedReview`, and it's also applied inside the picker for defense-in-depth.

---

[[../README]] · [[../../CLAUDE]]
