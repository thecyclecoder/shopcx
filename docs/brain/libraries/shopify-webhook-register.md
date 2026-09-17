# libraries/shopify-webhook-register

Registers Shopify webhook subscriptions per workspace on connect.

**File:** `src/lib/shopify-webhook-register.ts`

## Exports

### `registerShopifyWebhooks` — function

```ts
async function registerShopifyWebhooks(shop: string, accessToken: string, callbackUrl: string) : Promise<
```

## Callers

- `src/app/api/shopify/callback/route.ts`
- `src/app/api/workspaces/[id]/integrations/shopify/webhooks/route.ts`

## Registered topics

- `customers/create` / `customers/update` — customer sync (see [[shopify-webhooks]] `handleCustomerUpdate`).
- `orders/create` / `orders/updated` — order sync + Meta CAPI (see [[shopify-webhooks]] `handleOrderEvent`).
- `disputes/create` / `disputes/update` — chargebacks.
- `subscription_billing_attempts/success` | `/failure` | `/challenged` — dunning triggers ([[shopify-billing-attempt-webhook]]).
- `refunds/create` — vendor-side refund mirror. Without this topic, a refund fired in the Shopify admin writes NOTHING to [[../tables/order_refunds]] and the double-refund guard in [[refund]] `refundOrder` reads an incomplete ledger — 28 of 69 fully-refunded orders under-reported when the topic was unregistered (2026-09-11). Handled by [[shopify-webhooks]] `handleRefundCreate` → [[vendor-refund-mirror]] `insertShopifyRefundMirror`.

## Gotchas

- **422 on an unknown topic name looks like "already registered".** The old fast-path treated every 422 as registered; a typo (invalid topic) surfaces as 422 too. `registerShopifyWebhooks` verifies against the live webhook list before counting a 422 as green — a topic that's 422 AND absent from the shop's list is reported as an error.

---

[[../README]] · [[../../CLAUDE]]


## `subscription_contracts/create` + `/update` (added 2026-09-17)

The main way NEW ShopCX subscriptions arrive — a PDP checkout with a selling plan. Both were
already registered on the live shop by hand but were **missing from `WEBHOOK_TOPICS`**, so a
re-install would have dropped them silently and every new subscriber would have existed on Shopify
and nowhere in ShopCX. Handled by [[../inngest/shopcx-contract-ingest]].
