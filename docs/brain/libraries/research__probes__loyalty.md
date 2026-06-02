# libraries/research/probes/loyalty

Loyalty state probe.

**File:** `src/lib/research/probes/loyalty.ts`

## File header

```
Loyalty coupon state probe — used by recipes that need to know what
coupons exist for a customer, which are currently applied to which
subscriptions, and which are actually used per Shopify (our DB's
`loyalty_redemptions.status` column lags behind Shopify's real
`asyncUsageCount`).
```

## Exports

### `getLoyaltyAndSubState` — function

```ts
async function getLoyaltyAndSubState(workspaceId: string, customerId: string) : Promise<
```

### `LoyaltyCouponState` — interface

### `SubscriptionDiscountState` — interface

## Callers

- `src/lib/research/recipes/verify-coupon-promises.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
