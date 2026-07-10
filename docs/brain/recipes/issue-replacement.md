# Issue a replacement order

Create a fresh Shopify order at no cost to the customer. Replaces missing / damaged / lost items.

## Helper

```ts
import { createReplacementOrder } from "@/lib/replacement-order";
```

**File:** `src/lib/replacement-order.ts` (line 71)

## Signature

```ts
async function createReplacementOrder(input: CreateReplacementInput): Promise<CreateReplacementResult>
```

`CreateReplacementInput`:
```ts
{
  workspaceId: string;
  customerId: string;
  shopifyCustomerId: string;
  items: Array<{ variantId: string; quantity: number; title?: string }>;
  shippingAddress: { firstName?: string; lastName?: string; address1: string; address2?: string; city: string; province?: string; provinceCode?: string; zip: string; countryCode?: string };
  reason: string;
}
```

## Minimal example — single item

```ts
const result = await createReplacementOrder({
  workspaceId,
  customerId,
  shopifyCustomerId: customer.shopify_id,
  items: [
    { variantId: "12345678901234", quantity: 1, title: "Mixed Berry Tabs" },
  ],
  shippingAddress: {
    firstName: customer.first_name,
    lastName: customer.last_name,
    address1: customer.default_address.address1,
    city: customer.default_address.city,
    zip: customer.default_address.zip,
    countryCode: customer.default_address.country_code,
  },
  reason: "Missing items — original order SC129467",
});

if (!result.success) throw new Error(result.error || "replacement failed");
```

## Example — multi-item (two-flavor replacement)

One call creates ONE Shopify order with TWO line items (no fragmentation):

```ts
const result = await createReplacementOrder({
  workspaceId,
  customerId,
  shopifyCustomerId: customer.shopify_id,
  items: [
    { variantId: "peach_mango_variant_id", quantity: 1, title: "Peach Mango" },
    { variantId: "strawberry_lemonade_variant_id", quantity: 1, title: "Strawberry Lemonade" },
  ],
  shippingAddress: {
    firstName: customer.first_name,
    lastName: customer.last_name,
    address1: customer.default_address.address1,
    city: customer.default_address.city,
    zip: customer.default_address.zip,
    countryCode: customer.default_address.country_code,
  },
  reason: "Replacement — customer owed two flavors",
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
