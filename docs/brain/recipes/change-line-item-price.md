# Change line item price

Update the **visible MSRP** of a line item on an Appstle subscription. The helper applies the 0.75 SubSave multiplier internally, so the value you pass is the customer-facing MSRP, NOT the post-SubSave price.

## Helper

```ts
import { subUpdateLineItemPrice } from "@/lib/subscription-items";
```

**File:** `src/lib/subscription-items.ts` (line 423)

## Signature

```ts
async function subUpdateLineItemPrice(args: {
  workspaceId: string;
  contractId: string;          // Appstle contract id (or our UUID if internal)
  shopifyVariantId: string;    // bare numeric Shopify variant id
  basePriceCents: number;      // VISIBLE MSRP in cents
}): Promise<{ success: boolean; error?: string }>
```

## Minimal example

```ts
// Customer should see $19.99 on their next subscription order:
const result = await subUpdateLineItemPrice({
  workspaceId,
  contractId: subscription.shopify_contract_id,
  shopifyVariantId: variant.shopify_variant_id,
  basePriceCents: 1999,   // $19.99 MSRP
});

if (!result.success) {
  // Log to internal note + escalate; don't claim the price changed.
  throw new Error(result.error || "price update failed");
}
```

The contract ends up with `1999 * 0.75 = 1499` cents on the actual line, but the customer sees $19.99 MSRP with a "Subscribe & Save" badge — `1499 / 1999 = 25% off`. That's the deal.

## Gotchas

- **0.75 is baked in.** Pass MSRP. If you compute the SubSave price first and pass that, you'll multiply twice — final price = 56.25% of intended.
- **Internal-sub guard.** If the sub is internal (`is_internal=true`), the helper short-circuits to `internal-subscription.ts` and updates Postgres directly — no Appstle call. You don't need to handle this branch.
- **Variant id is the bare numeric** Shopify id (`12345678901234`), not the GID (`gid://shopify/ProductVariant/...`).
- **Grandfathered subs.** Don't lower the price below `workspaces.coupon_price_floor_pct` of MSRP for grandfathered customers — see project_grandfathered_pricing.

## Related

[[../libraries/subscription-items]] · [[../tables/subscriptions]] · [[../integrations/appstle]] · [[swap-variant]] · [[change-quantity]]
