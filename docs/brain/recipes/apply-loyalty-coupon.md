# Apply a loyalty coupon to a subscription

After a customer redeems points and you have a coupon code, attach it to their subscription. Same `applyDiscountWithReplace` path as [[apply-coupon]] but with one critical difference: loyalty coupons bypass the grandfathered-pricing floor.

## Helpers

```ts
import { applyDiscountWithReplace } from "@/lib/appstle-discount";
```

The canonical end-to-end flow lives in `src/lib/portal/handlers/loyalty-apply-subscription.ts`.

## Minimal example

```ts
await applyDiscountWithReplace({
  workspaceId,
  contractId: subscription.shopify_contract_id,
  shopifyCouponCode: redemption.coupon_code,
  source: "loyalty",   // important — bypasses the price floor check
});
```

## Gotchas

- **Grandfathered subs ARE allowed loyalty coupons.** The price floor only blocks sale coupons. Pass `source: "loyalty"` (or use the loyalty-apply handler directly) to skip the floor check.
- **One coupon per sub still applies.** If there's already a loyalty coupon active, it gets replaced. Customer surfaces this in their portal.
- **Don't apply twice.** The redemption ledger should already show one applied redemption — re-applying the same code is a no-op on Shopify's side but creates a confusing customer history.
- **Self-heal regeneration is idempotent — Shopify verify-fail→retry never double-deducts.** The [[../libraries/portal__handlers__loyalty-apply-subscription]] handler's self-heal path regenerates a new code when Shopify rejects the original (stale or other reason). Multiple retries (verify failure + caller timeout) can trigger multiple regen attempts; `claimRegenSpendSlot` ([[../libraries/action-executor]]) gates the spend atomically so only the first regen winner calls `spendPoints`, and retry callers apply the successor code instead. One applied coupon = exactly one points spend (spec: [[../specs/loyalty-coupon-apply-self-heal-must-not-double-deduct-points]] Phase 2).
- **Internal subs** apply in our DB; no Appstle call.

## Related

[[redeem-loyalty]] · [[apply-coupon]] · [[../libraries/appstle-discount]] · [[../libraries/loyalty]] · [[../tables/loyalty_redemptions]]
