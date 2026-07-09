# libraries/shopify-order-actions

Shopify order mutations: refunds, cancellations, address updates. Bridges to [[../integrations/braintree]] for Braintree-paid orders.

**File:** `src/lib/shopify-order-actions.ts`

## Exports

### `refundOrder` — function

```ts
async function refundOrder(workspaceId: string, shopifyOrderId: string, options: { full?: boolean; lineItems?: { lineItemId: string; quantity: number }[]; reason?: string; notify?: boolean; }) : Promise<
```

### `partialRefundByAmount` — function

```ts
async function partialRefundByAmount(workspaceId: string, shopifyOrderId: string, amountCents: number, reason?: string,) : Promise<
```

Returns `{ success, error?, method?, needsBraintreeFallback?, braintreeTxnId?, needsManualShopifyRecord?, alreadyPending? }`.

**Already-in-flight guard (`alreadyPending`).** After fetching the order's transactions it runs `findPendingRefundTxn` — if a `kind:'refund'` transaction is still `pending` on the gateway (PayPal, and other async gateways, settle a refund over a few business days), it returns `{ success:false, alreadyPending:true, error:"A refund of $X is already pending…" }` and issues **no** duplicate. Without this guard a second refund attempt hit Shopify's balance ceiling and came back `{"base":["Transaction cannot be refunded"]}`, which the box escalated as a cryptic hard failure (Amy / SC133495, 2026-07 — a $67.81 PayPal refund pending for a day). `refundOrder` propagates `alreadyPending`; [[action-executor]] `partial_refund` surfaces it as a benign "already processing" outcome, not an escalation.

### `findPendingRefundTxn` — function (pure)

```ts
function findPendingRefundTxn(transactions: ShopifyTxnLite[] | null | undefined): ShopifyTxnLite | null
```

Pure detector: the first `kind:'refund'` transaction whose status is `pending` (case-insensitive), else null. Any positive amount counts — we never issue a second refund while one is settling (the balance math is the gateway's job, and it rejects duplicates anyway). Unit-tested in `shopify-order-actions.pending-refund.test.ts`.

### `recordManualRefund` — function

```ts
async function recordManualRefund(workspaceId: string, shopifyOrderId: string, amountCents: number, note?: string,) : Promise<
```

### `refundOrderViaBraintree` — function

```ts
async function refundOrderViaBraintree(workspaceId: string, shopifyOrderId: string, amountCents: number, reason?: string,) : Promise<
```

### `cancelOrder` — function

```ts
async function cancelOrder(workspaceId: string, shopifyOrderId: string, options: { reason: "CUSTOMER" | "FRAUD" | "INVENTORY" | "DECLINED" | "OTHER"; refund?: boolean; restock?: boolean; notify?: boolean; }) : Promise<
```

### `updateShippingAddress` — function

```ts
async function updateShippingAddress(workspaceId: string, shopifyOrderId: string, address: { address1: string; address2?: string; city: string; province: string; zip: string; country: string; }) : Promise<
```

## Callers

- `src/app/api/tickets/[id]/order-actions/route.ts`
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
