# libraries/subscription-items

**Status:** Deprecated. M4 migrated dashboard + agent + AI to [[../libraries/commerce__subscription]]. M5 (2026-06-20) migrated portal surfaces to the Commerce SDK; legacy subscription-items shims are preserved for backward compatibility but portal no longer calls them directly.

Legacy Appstle line-item mutations: swap, add, remove, price update, quantity update. Wraps Appstle's subscription-contract-* endpoints. **Has 0.75 SubSave price multiplier baked into `subUpdateLineItemPrice`** — set the visible price; the multiplier shifts it to the post-SubSave price on the contract.

**File:** `src/lib/subscription-items.ts`

## File header

```
Unified subscription line item mutations via Appstle replaceVariants-v3
All subscription item changes (add, remove, swap, quantity) go through this single module.
```

## Exports

### `resolveVariantTitles` — function

```ts
async function resolveVariantTitles(workspaceId: string, variantIds: string[],) : Promise<Map<string,
```

### `enrichItemTitles` — function

```ts
async function enrichItemTitles(workspaceId: string, items: Record<string, unknown>[],) : Promise<Record<string, unknown>[]>
```

### `getAppstleConfig` — function

```ts
async function getAppstleConfig(workspaceId: string) : Promise<
```

### `resolveContractVariantId` — function

```ts
async function resolveContractVariantId(workspaceId: string, contractId: string, idOrTitle: string,) : Promise<
```

### `appstleRemoveLineItem` — function

```ts
async function appstleRemoveLineItem(workspaceId: string, contractId: string, variantOrLine: { variantId?: string; lineGid?: string },) : Promise<
```

### `subAddItem` — function

```ts
async function subAddItem(workspaceId: string, contractId: string, variantId: string, quantity: number = 1,) : Promise<
```

### `subAddOneTimeGift` — function (internal-aware)

```ts
async function subAddOneTimeGift(
  workspaceId: string, contractId: string, variantId: string, quantity = 1,
  opts: { free?: boolean; priceCents?: number | null } = {},
): Promise<{ success: boolean; error?: string; free_confirmed?: boolean; backend?: "internal" | "appstle" }>
```

Add a **one-time** item to the sub's NEXT renewal that ships once then **drops off** (never recurs) — the "add a frother as a gift with my next order" / "add a bag to my next order" mechanism. Backs the `add_one_time_gift` direct action ([[action-executor]]) and the [[sol-outcome-claim-guard|add_bag_to_next_order]] outcome kind. `opts.free` defaults **true** (a $0 gift).

- **Internal sub** → native: [[internal-subscription]] `internalSubAddOneTimeGift` appends a one-time line to `subscriptions.items[]`. A free gift is `is_gift:true` (the [[pricing]] engine forces `unit_cents:0`); every one-time line carries `one_time_next_renewal:true`, which the [[../inngest/internal-subscription-renewals]] engine **drops after the order ships** (its "Drop any one_time_next_renewal items now that they've shipped" step). Fully DB-owned — verified end-to-end.
- **Appstle sub** → `replace-variants-v3` with `newOneTimeVariants` (the native one-time add; `resolveShopifyVariantId` maps a UUID → numeric Shopify variant id first). A **paid** add-on lands as-is (bills at its variant price). A **free** gift additionally zeroes the new one-time line's base price via `zeroAppstleOneTimeLine` (`update-line-item-price` `basePrice=0.00`); **if the $0 cannot be confirmed the add is rolled back** (`oldOneTimeVariants` remove) and the call returns `success:false` — a gift must never silently charge. Callers then fall back to a standalone $0 gift order ([[commerce__replacement|issueReplacement]]).

`free_confirmed` tells the caller whether it may honestly tell the customer "free". **Appstle-free zeroing wants a one-time live confirmation** on a real contract (the one-time-line GID shape isn't yet verified against a live Appstle contract) — the rollback makes an unconfirmed attempt safe, not silent.

### `subRemoveItem` — function

```ts
async function subRemoveItem(workspaceId: string, contractId: string, variantOrLine: string | { variantId?: string; lineGid?: string },) : Promise<
```

### `subChangeQuantity` — function

```ts
async function subChangeQuantity(workspaceId: string, contractId: string, variantId: string, quantity: number,) : Promise<
```

### `subUpdateLineItemPrice` — function

```ts
async function subUpdateLineItemPrice(workspaceId: string, contractId: string, variantId: string, basePriceCents: number, lineGid?: string,) : Promise<
```

### `getLastOrderPrice` — function

```ts
async function getLastOrderPrice(workspaceId: string, customerId: string, sku: string | null, variantId: string | null,) : Promise<number | null>
```

### `calcBasePrice` — function

```ts
function calcBasePrice(targetPriceCents: number, discountPercent: number) : number
```

### `decideSwapNewLineBaseCents` — function (pure)

```ts
function decideSwapNewLineBaseCents(input: {
  oldItemPriceCents: number | null; oldStandardCents: number | null;
  newStandardCents: number | null; snsPct?: number;
}): number | null
```

Decides the Appstle `basePrice` (cents) to set on the NEW line after a **single-item portal swap** so the swapped-in product carries the subscriber S&S discount, **not flat MSRP**. Returns `null` to leave Appstle's value (no catalog price for the new variant). Used by [[../../../src/lib/portal/handlers/replace-variants|replaceVariants]] post-swap.

- **Grandfathered preserve** — old line below its own catalog standard AND new variant shares that standard (like-for-like): return the reverse-engineered old base (`round(oldPrice / (1 − sns))`).
- **Standard subscriber** — any other single swap with a known new catalog price: return the new variant's MSRP (the 25% S&S cycle discounts it → subscriber price).

**Derived from ticket `d19c2192`** (2026-07-10): the old inline logic in `replaceVariants` only repriced when `newStandard === oldStandard`, so a swap to a **different-priced** product (Creatine Prime → Amazing Creamer) left the new line at full MSRP ($69.95, 0% off) instead of the subscriber $52.46. `snsPct` defaults to 25 (parity with the surrounding hardcode); per-product `subscribe_discount_pct` awareness ([[appstle-pricing]] `resolveLineSnsPct`) is a follow-up.

### `subSwapVariant` — function

```ts
async function subSwapVariant(workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string, quantity: number = 1,) : Promise<
```

### `subscriptionApplyCoupon` — function

```ts
async function subscriptionApplyCoupon(workspaceId: string, contractId: string, code: string,) : Promise<{ success: boolean; error?: string }>
```

Internal-aware coupon apply. Internal subs: `resolveCoupon` (internal wins → Shopify fallback) → `internalSubApplyDiscount` writes `subscriptions.applied_discounts`. Appstle subs: `healOnTouch` → `applyDiscountWithReplace`.

### `subscriptionRemoveCoupon` — function

```ts
async function subscriptionRemoveCoupon(workspaceId: string, contractId: string, discountIdOrCode: string,) : Promise<{ success: boolean; error?: string }>
```

Internal-aware coupon remove. Internal subs: `internalSubRemoveDiscount`. Appstle subs: `healOnTouch` → `removeExistingDiscounts` (1-coupon-per-sub, so `discountIdOrCode` is only consulted for the internal filter).

## Callers

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/app/api/workspaces/[id]/crisis/[crisisId]/auto-swap/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/coupon/route.ts` — `subscriptionApplyCoupon` (POST) / `subscriptionRemoveCoupon` (DELETE)
- `src/app/api/workspaces/[id]/subscriptions/[subId]/items/route.ts`
- `src/lib/action-executor.ts` — `subscriptionApplyCoupon` (apply_coupon + apply_loyalty_coupon) / `subscriptionRemoveCoupon` (remove_coupon)
- `src/lib/portal/handlers/remove-line-item.ts`
- `src/lib/portal/handlers/replace-variants.ts`

## Gotchas

- `subUpdateLineItemPrice` has the 0.75 SubSave multiplier **baked in** — pass the visible MSRP, the helper applies × 0.75 before sending to Appstle. If you compute the SubSave price first, you'll end up at 0.5625 of MSRP.
- Every helper checks `isInternalSubscription()` first. Internal subs bypass Appstle.
- Variant ids must be Shopify variant ids when crossing into Appstle — internal UUIDs won't work.
- `subUpdateLineItemPrice` is the **restore-the-grandfathered-base** step of subscription overcharge remediation ([[subscription-overcharge]]): it heals the Appstle sub in place (`healOnTouch` first) or sets `price_override_cents` for internal subs. The `update_line_item_price` direct action ([[action-executor]]) now **routes internal subs first** (before the Appstle config/lineId fetch, which would fail with "Appstle not configured" for an internal sub).
- `appstleRemoveLineItem` recognizes Appstle's **own last-item guardrail**: a `400` whose body matches `"must be present in a subscription"` / `"UserGeneratedError"` (Appstle refuses to remove the last recurring product). This is logged at `console.warn` (not `console.error`) and returned as `{ success: false, error: "would_remove_last_item" }` — the same friendly outcome [[portal__handlers__remove-line-item]]'s local pre-check produces. Without this, a stale-high local items snapshot would let the removal slip past the pre-check and Appstle's 400 would surface as a logged ERR + opaque 502 (Control Tower signature `vercel:0dda1c7b9495ebb1`). The handler maps `would_remove_last_item` straight to its friendly 400.

---

[[../README]] · [[../../CLAUDE]]
