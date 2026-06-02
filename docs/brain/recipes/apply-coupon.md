# Apply a coupon to a subscription

One coupon per sub — never stack. The helper removes any existing coupon first.

## Helper

```ts
import { applyDiscountWithReplace } from "@/lib/appstle-discount";
```

**File:** `src/lib/appstle-discount.ts` (line 77)

## Signature

```ts
async function applyDiscountWithReplace(args: {
  workspaceId: string;
  contractId: string;
  shopifyCouponCode: string;
}): Promise<{ success: boolean; error?: string; removedDiscountIds?: string[] }>
```

## Minimal example

```ts
const result = await applyDiscountWithReplace({
  workspaceId,
  contractId: subscription.shopify_contract_id,
  shopifyCouponCode: "SHOPCX",
});

if (!result.success) {
  // Don't tell the customer the coupon is applied.
  console.error("apply coupon failed:", result.error);
}
```

## Resolving codes by VIP tier

When you don't know the exact code (e.g. AI-driven coupon selection), use [[../tables/coupon_mappings]] to resolve by VIP tier:

```ts
import { resolveCouponForCustomer } from "@/lib/marketing-coupons";

const code = await resolveCouponForCustomer(workspaceId, customerId);
if (code) await applyDiscountWithReplace({ workspaceId, contractId, shopifyCouponCode: code });
```

## Gotchas

- **One coupon per sub. Never stack.** The helper enforces this by removing existing discounts first.
- **Grandfathered subs get blocked from sale coupons** below `workspaces.coupon_price_floor_pct` of MSRP. Loyalty coupons are always allowed (separate code path).
- **Internal subs** apply the discount in our DB; no Appstle call.
- **Shopify-side coupon must exist.** This calls Appstle which calls Shopify — invalid codes return `success=false` with the Shopify error.

## Related

[[../libraries/appstle-discount]] · [[../libraries/marketing-coupons]] · [[../tables/coupon_mappings]] · [[apply-loyalty-coupon]] · [[../journeys/discount-signup]]
