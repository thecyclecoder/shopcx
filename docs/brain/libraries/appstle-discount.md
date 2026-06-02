# libraries/appstle-discount

`applyDiscountWithReplace()` — removes any existing coupon, then applies a new one atomically. One coupon per sub — never stack. Driven by [[../tables/coupon_mappings]] for VIP-tier resolution.

**File:** `src/lib/appstle-discount.ts`

## File header

```
Shared Appstle discount helpers — single source of truth for coupon apply/remove.
RULE: Only 1 coupon per subscription. Always remove existing before applying new.
Reads discount IDs from local DB (synced via webhook), not from Appstle API.
Writes to both Appstle (mutation) and local DB (immediate update, don't wait for webhook).
```

## Exports

### `removeExistingDiscounts` — function

```ts
async function removeExistingDiscounts(apiKey: string, contractId: string,) : Promise<
```

### `applyDiscountWithReplace` — function

```ts
async function applyDiscountWithReplace(apiKey: string, contractId: string, discountCode: string,) : Promise<
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
