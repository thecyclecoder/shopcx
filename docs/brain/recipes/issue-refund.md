# Issue a refund

For returns, the refund happens automatically when EasyPost confirms delivery — see [[../inngest/returns]] `returns-issue-refund`. This recipe covers manual refunds (admin override, agent action).

## Helper

```ts
import { partialRefundByAmount } from "@/lib/shopify-order-actions";
```

**File:** `src/lib/shopify-order-actions.ts` (line 155)

## Signature

```ts
async function partialRefundByAmount(
  workspaceId: string,
  orderId: string,
  amountCents: number,
  reason?: string,
): Promise<{ success: boolean; refundId?: string; method?: "shopify" | "braintree"; error?: string; needsManualShopifyRecord?: boolean }>
```

## Minimal example

```ts
const result = await partialRefundByAmount(
  workspaceId,
  order.id,
  587,                          // $5.87
  "Customer goodwill — late delivery",
);

if (!result.success) {
  // Most common failure: Braintree::AuthenticationError from a stale gateway.
  // Caller should insert a dashboard_notifications row + escalate.
  console.error("refund failed:", result.error);
}
```

## Gateway routing

`partialRefundByAmount` picks the gateway automatically:

- Shopify Payments orders → Shopify `refundCreate` mutation.
- Braintree (custom checkout) → [[../integrations/braintree]] `transaction.refund` via `refundBraintreeTransaction()`. `needsManualShopifyRecord=true` flags that the Shopify side needs reconciliation.

## Full refund variant

For full refunds on an order, use `refundOrder()` instead:

```ts
import { refundOrder } from "@/lib/shopify-order-actions";

await refundOrder(workspaceId, order.id, "Defective product");
```

## Gotchas

- **For returns, don't call this directly.** [[../inngest/returns]] `returns-issue-refund` is the canonical path — it reads `net_refund_cents` from the return contract. Calling refund directly bypasses the contract.
- **Avalara void.** If the order has `avalara_transaction_code`, void it via [[../libraries/avalara]] OR the next tax filing over-remits. The refund helper handles this; manual paths must not skip it.
- **Braintree refund eligibility** depends on transaction state: settled → refund OK; authorized but not settled → use `transaction.void` instead.
- **Failure isn't always a bug.** `Braintree::AuthenticationError` is the most common; admin fix is to re-auth the gateway. Surface via [[../tables/dashboard_notifications]].

## Related

[[partial-refund]] · [[../libraries/shopify-order-actions]] · [[../libraries/integrations__braintree]] · [[../integrations/braintree]] · [[../lifecycles/return-pipeline]] · [[create-return]]
