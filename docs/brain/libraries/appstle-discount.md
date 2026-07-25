# libraries/appstle-discount

`applyDiscountWithReplace()` — replaces the CODE half of a subscription's discounts. AUTOMATIC_DISCOUNT (free shipping, Buy 2/3) and MANUAL (cancel-flow retention) rows stack on top of the code and are never touched. Driven by [[../tables/coupon_mappings]] for VIP-tier resolution.

**File:** `src/lib/appstle-discount.ts`

## Invariant

**Only ONE CODE discount per subscription. AUTOMATIC_DISCOUNT and MANUAL discounts stack on top and are never touched by apply-with-replace.** Two CODE discounts (two loyalty, two promo, or one of each) is the only illegal combination — that is the sole thing this module enforces.

Real observed `applied_discounts.type` values (probed 2026-07-25): `AUTOMATIC_DISCOUNT` ('Free Shipping on Subscriptions', 'Buy 2 Discount', 'Buy 3 Discount'), `MANUAL` ('cancel27864596653'-style retention offers), `CODE_DISCOUNT` (LOYALTY-*). Unknown / missing type is treated as PRESERVE — never removable.

## Exports

### `removeExistingDiscounts` — function

```ts
async function removeExistingDiscounts(apiKey: string, contractId: string) : Promise<{
  removed: string[];                 // discount IDs the Appstle remove PUT was issued for (CODE_DISCOUNT only)
  preserved: StoredDiscount[];       // AUTOMATIC_DISCOUNT / MANUAL / unknown-type rows deliberately left on the contract
  error?: string;
}>
```

Partitions `subscriptions.applied_discounts` by `type === 'CODE_DISCOUNT'`. Only CODE rows are PUT to `subscription-contracts-remove-discount`. On success the local `applied_discounts` is rewritten to the preserved rows (NOT `[]`) so the next apply sees the surviving automatics/manuals.

### `applyDiscountWithReplace` — function

```ts
async function applyDiscountWithReplace(apiKey: string, contractId: string, discountCode: string) : Promise<{ success; removed; error?; status? }>
```

Fast path: if the subscription is internal, only the CODE_DISCOUNT rows in `applied_discounts` are cleared before delegating to `internalSubApplyDiscount`. Automatics/manuals survive.

## Callers

- `src/lib/subscription-items.ts` — `subscriptionApplyCoupon`, `subscriptionRemoveCoupon`
- `src/app/api/journey/[token]/complete/route.ts` — journey coupon fulfillment
- `src/lib/portal/handlers/loyalty-apply-subscription.ts` — loyalty portal apply
- `src/lib/portal/handlers/cancel-journey.ts` — cancel-flow retention
- `src/lib/portal/handlers/coupon.ts` — manual coupon apply from portal

## Gotchas

- **CODE_DISCOUNT is the only removable type.** A caller that hands back an `error` string does NOT mean nothing was removed — check `removed` and `preserved` on the return.
- **The local write-back preserves what stays on the contract.** Never overwrite `applied_discounts` with `[]` in this module — the pre-fix bug (2026-07-24 Sandra Lutz, contract 34148253869) silently stripped 'Free Shipping on Subscriptions' by doing exactly that.
- **Verification test:** `src/lib/appstle-discount.code-only.test.ts` pins the invariant.

---

[[../README]] · [[../../CLAUDE]]
