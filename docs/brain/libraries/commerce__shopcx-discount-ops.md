# `src/lib/commerce/shopcx-discount-ops.ts`

Coupon apply/remove for **ShopCX-billed** subscriptions. Reached through
[[commerce__subscription]] `applyCoupon` / `removeCoupon` (→ `subscription-items.ts`
`subscriptionApplyCoupon`) and through [[coupons]] `applyCouponToSub` / `removeCouponFromSub`.

## ⭐ A coupon is minted as a MANUAL discount from OUR resolution — never handed to Shopify as a code

`subscriptionDraftDiscountCodeApply` exists (probed directly — Shopify hides the whole subscription
draft surface from introspection, so the schema cannot be trusted here). We deliberately do not use
it:

1. **Most of our codes have no Shopify existence.** Loyalty codes are internal-native by design:
   a Shopify-minted loyalty code was deleted upstream and silently zeroed the discount at renewal
   (ticket `46a7aa75`). `resolveCoupon` is the only authority that can price them.
2. **`resolveCoupon` carries the rails** — internal-wins precedence, the derived-code owner check,
   the single-use ceiling. A redeem code handed to Shopify bypasses every one of them.

Routing Shopify-native codes through a second path would also give promo and loyalty different
semantics on the same contract.

## The code burns at APPLY time, not at charge time

The internal engine records the redemption when it charges, because it *is* the charge. Shopify
consumes the discount on its own schedule and we only learn after the fact, so waiting leaves a
window in which the same single-use loyalty code lands on a second subscription. Burning early can
at worst deny a customer a code they have already spent; burning late hands out the discount twice.

## Shape

| | Value |
|---|---|
| Target | order-wide (`entitledLines: {all: true}`) — a coupon is not variant-scoped, which is what distinguishes it from the grandfathered rate |
| Title | the code itself (a code colliding with a `STRUCTURAL_DISCOUNT_TITLES` entry is **refused**) |
| Lifetime | `recurringCycleLimit` from `resolved.recurring_cycle_limit`; loyalty is `1`, so Shopify expires it and nothing has to sweep it off later |
| Invariant | one coupon per subscription — apply REPLACES, in the same draft (split across two commits, a charge landing between them stacks both codes) |

`shopcxRemoveCoupon` clears **every** non-structural discount rather than matching the passed code:
the one-per-sub invariant makes "the coupon" unambiguous, and a migrated contract carrying a code
discount Appstle left behind has to be removable even though its title never matched.

## Interaction with the structural recompute

Neither half can damage the other, by construction:

- [[commerce__shopcx-line-ops]] only touches MANUAL discounts whose title is in
  `STRUCTURAL_DISCOUNT_TITLES`; a coupon is titled with its own code.
- The removals here never touch a structural title, so clearing a coupon cannot strip a customer's
  grandfathered rate.
- `structuralDiscountCents` counts only our allocations, so a coupon can never be absorbed into a
  permanent `Legacy rate`. Verified live — see [[commerce__shopcx-line-ops]] § Verified live.

## Related

[[commerce__shopcx-line-ops]] · [[commerce__shopify-subscription-client]] · [[coupons]] ·
[[commerce__subscription]] · [[../lifecycles/shopcx-subscriptions]] · [[../lifecycles/cancel-flow]]
