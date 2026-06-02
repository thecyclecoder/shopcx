# Create a return

The single entry point for any new return. Anyone bypassing this will hit the from/to label-swap bug or break the refund-amount contract.

## Helper

```ts
import { createFullReturn } from "@/lib/shopify-returns";
```

**File:** `src/lib/shopify-returns.ts` (line 702)

## Signature

```ts
async function createFullReturn(params: {
  workspaceId: string;
  orderId: string;
  customerId: string;
  resolutionType: "refund_return" | "store_credit_return" | "refund_no_return" | "store_credit_no_return";
  lineItems: Array<{ orderLineItemId: string; quantity: number }>;
  freeLabel?: boolean;
  source: "ai" | "agent" | "playbook" | "portal" | "system";
  reason?: string;
  parcel?: { length: number; width: number; height: number; weight: number };
}): Promise<{ success: boolean; returnId?: string; trackingNumber?: string; labelUrl?: string; error?: string }>
```

## Minimal example

```ts
const result = await createFullReturn({
  workspaceId,
  orderId: order.id,
  customerId,
  resolutionType: "refund_return",   // refund to original card, customer returns the product
  lineItems: [{ orderLineItemId: line.id, quantity: 1 }],
  freeLabel: false,                  // customer pays return shipping
  source: "agent",
  reason: "Customer changed mind",
});

if (!result.success) throw new Error(result.error || "return create failed");

// Send the label email — the helper inserts the row + label_url but doesn't send.
import { sendReturnLabelEmail } from "@/lib/easypost-email";
await sendReturnLabelEmail({ workspaceId, customerId, returnId: result.returnId!, labelUrl: result.labelUrl! });
```

## Gotchas

- **`net_refund_cents` is set at creation.** That's the contract — the issue-refund pipeline trusts it forever. Never re-derive at refund time.
- **`freeLabel: true`** = we eat the EasyPost cost, `label_cost_cents=0`, `net_refund_cents = order_total_cents`.
- **`freeLabel: false`** = `label_cost_cents = actual EasyPost rate`, `net_refund_cents = order_total - label`.
- **`*_no_return`** resolutions skip the label entirely. Customer keeps the product, gets full refund or full store credit.
- **Never set `is_return: true` on EasyPost directly.** That's the from/to swap bug. The helper builds the address pair manually.
- **Send the label email yourself.** `createFullReturn` does not send. See feedback_return_label_in_reply.
- **Crisis returns** must use `freeLabel: true` + `source: "ai"`. See feedback_crisis_return_auto.

## Related

[[../libraries/shopify-returns]] · [[../lifecycles/return-pipeline]] · [[../tables/returns]] · [[../integrations/easypost]] · [[issue-refund]] · [[issue-replacement]]
