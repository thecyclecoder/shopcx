# Issue a replacement order

Create a fresh Shopify order at no cost to the customer. Replaces missing / damaged / lost items.

## Helper

```ts
import { createReplacementOrder } from "@/lib/replacement-order";
```

**File:** `src/lib/replacement-order.ts` (line 71)

## Signature

```ts
async function createReplacementOrder(input: {
  workspaceId: string;
  customerId: string;
  originalOrderId?: string;
  lineItems: Array<{ shopifyVariantId: string; quantity: number; title?: string }>;
  shippingAddress: ShippingAddress;
  reason?: string;
}): Promise<{ success: boolean; orderId?: string; error?: string }>
```

## Minimal example

```ts
const result = await createReplacementOrder({
  workspaceId,
  customerId,
  originalOrderId: originalOrder.id,
  lineItems: [
    { shopifyVariantId: "12345678901234", quantity: 1, title: "Mixed Berry Tabs" },
  ],
  shippingAddress: customer.default_address,
  reason: "Missing items — original order SC129467",
});

if (!result.success) throw new Error(result.error || "replacement failed");
```

## Gotchas

- **Stamped `replacement: true` on the order** — downstream events skip marketing attribution + LTV bump. Don't undo this.
- **Address must be confirmed.** If the original address is bad (delivery failure root cause), confirm via [[../journeys/shipping-address]] FIRST. Re-using a bad address just re-fails.
- **Tracks against threshold.** `workspaces.replacement_threshold_cents` — if the customer's cumulative replacement value crosses it, escalate before issuing.
- **Insert [[../tables/replacements]] row.** The helper does this; don't duplicate.
- **No customer payment.** This is a draft order completed with `payment_pending=false` — Shopify ships it without charging.

## Related

[[../libraries/replacement-order]] · [[../lifecycles/return-pipeline]] · [[../playbooks/replacement-order]] · [[../tables/replacements]] · [[../journeys/missing-items]] · [[create-return]]
