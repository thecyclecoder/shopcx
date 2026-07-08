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

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
