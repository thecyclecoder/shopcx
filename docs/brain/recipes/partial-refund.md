# Partial refund

Refund a subset of an order's total. Same `partialRefundByAmount` helper as [[issue-refund]] — the distinction is intent.

## Helper

```ts
import { partialRefundByAmount } from "@/lib/shopify-order-actions";
```

**File:** `src/lib/shopify-order-actions.ts` (line 155)

## Common scenarios

| Scenario | Suggested amount |
|---|---|
| Damaged item (one of many) | The line subtotal — no tax/shipping refund |
| Late delivery goodwill | 10-25% of line subtotal |
| Price drop / promo mismatch | `original_paid - current_promo_price` |
| Crisis swap remediation | Full line subtotal + tax pro-rata |

## Minimal example

```ts
// Partial refund for one of three identical line items
const refundAmount = line.unit_price_cents * 1;   // qty 1 of line
const result = await partialRefundByAmount(
  workspaceId,
  order.id,
  refundAmount,
  "Damaged one of three units",
);
```

## Gotchas

- **Same gotchas as [[issue-refund]].** Read that page first.
- **Tax accuracy.** For partial refunds, we don't auto-prorate Avalara tax — it stays on the order. If the customer demands a full tax refund pro-rata, add it to the refund amount manually.
- **Shipping is rarely refunded** on partial returns. If the original order had $7.99 shipping, returning one of three items doesn't entitle the customer to a third of that.
- **Don't refund more than `order_total_cents`.** Shopify rejects over-refund; Braintree rejects with `transaction not refundable`.

## Related

[[issue-refund]] · [[../libraries/shopify-order-actions]] · [[../tables/orders]] · [[../lifecycles/return-pipeline]]
