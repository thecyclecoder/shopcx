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
