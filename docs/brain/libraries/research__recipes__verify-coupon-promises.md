# libraries/research/recipes/verify-coupon-promises

Recipe: was a coupon promised but not applied?

**File:** `src/lib/research/recipes/verify-coupon-promises.ts`

## File header

```
verify_coupon_promises — checks the most recent AI/agent messages on
a ticket for claims about loyalty coupons being applied to subscriptions,
verifies each against (a) the sub's applied_discounts in our DB AND
(b) Shopify's authoritative asyncUsageCount for the code.
Surfaces three kinds of gaps:
- missing_coupon:<contract_id>      — AI said all subs got coupons, but this one has none
- applied_coupon_already_used:<...> — sub has code applied per DB but Shopify says usage=1/1
- no_coupon_for_active_subs         — generic "you'll see your reward applied" claim with zero subs holding any loyalty coupon
Proposed heals:
- apply_loyalty_coupon (if an unused coupon is available)
- redeem_points + apply_loyalty_coupon (chained, if no unused but points >= 1500)
```

## Exports

### `verifyCouponPromises` — const

```ts
const verifyCouponPromises: ResearchRecipe
```

## Callers

- `src/lib/research/index.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
