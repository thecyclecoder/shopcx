# Swap variant on a subscription

Change which variant a line is shipping (e.g. Mixed Berry → Strawberry Lemonade) without dropping + re-adding.

## Helper

```ts
import { subSwapVariant } from "@/lib/subscription-items";
```

**File:** `src/lib/subscription-items.ts` (line 543)

## Signature

```ts
async function subSwapVariant(args: {
  workspaceId: string;
  contractId: string;
  oldShopifyVariantId: string;
  newShopifyVariantId: string;
  preserveBasePriceCents?: number;   // if set, lock the price across swap
}): Promise<{ success: boolean; error?: string }>
```

## Minimal example

```ts
import { subSwapVariant } from "@/lib/subscription-items";

const result = await subSwapVariant({
  workspaceId,
  contractId: subscription.shopify_contract_id,
  oldShopifyVariantId: "12345678901234",   // Mixed Berry
  newShopifyVariantId: "98765432109876",   // Strawberry Lemonade
  preserveBasePriceCents: 1999,             // honor original MSRP
});
```

## Gotchas

- **Crisis swaps must pass `preserveBasePriceCents`** to honor the customer's locked-in price across the swap — see feedback_crisis_action_subscription_id and CRISIS-MANAGEMENT-SPEC.md.
- **Customer portal flavor swaps preserve grandfathered pricing** automatically. Product swaps (different SKU) do NOT preserve it. See project_grandfathered_pricing.
- **Internal-sub guard** runs first. Internal subs do the swap in our DB; no Appstle call.
- **Variant ids are numeric Shopify ids**, not GIDs.

## Related

[[../libraries/subscription-items]] · [[../lifecycles/crisis-campaign]] · [[change-line-item-price]] · [[change-quantity]]
