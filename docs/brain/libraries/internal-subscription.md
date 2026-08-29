# libraries/internal-subscription

Internal-subscription path (`is_internal=true`). Mutations are pure DB updates; no Appstle calls. Future home of the in-house billing-tick scheduler. See [[../lifecycles/subscription-billing]].

**File:** `src/lib/internal-subscription.ts`

## File header

```
Internal subscription engine.
Subscriptions with `is_internal = true` are managed entirely by
shopcx — no Appstle in the loop. Every Appstle helper checks the
flag and, if set, delegates to one of the handlers below. Same
function signatures + return shape as Appstle so callers don't
branch (the existing portal UI, the action_executor's direct
actions, the Sonnet-orchestrator paths — all work unchanged).
State the handlers mutate:
subscriptions.status                 active | paused | cancelled
subscriptions.next_billing_date      ISO date string
subscriptions.billing_interval       day | week | month | year (lowercase per our DB convention)
subscriptions.billing_interval_count integer
subscriptions.items                  JSONB array of line items
subscriptions.applied_discounts      JSONB array
subscriptions.pause_resume_at        ISO timestamp (for timed pauses)
Anything that requires a Braintree charge (attemptBilling) is
stubbed for now — the renewal scheduler lands in a future commit.
```

## Exports

### `isInternalSubscription` — function

```ts
async function isInternalSubscription(workspaceId: string, contractId: string) : Promise<boolean>
```

### `internalSubscriptionAction` — function

```ts
async function internalSubscriptionAction(workspaceId: string, contractId: string, action: "pause" | "cancel" | "resume",) : Promise<ActionResult>
```

### `internalSubSkipNextOrder` — function

```ts
async function internalSubSkipNextOrder(workspaceId: string, contractId: string) : Promise<ActionResult>
```

### `internalSubUpdateBillingInterval` — function

```ts
async function internalSubUpdateBillingInterval(workspaceId: string, contractId: string, interval: "DAY" | "WEEK" | "MONTH" | "YEAR", intervalCount: number,) : Promise<ActionResult>
```

### `internalSubUpdateNextBillingDate` — function

```ts
async function internalSubUpdateNextBillingDate(workspaceId: string, contractId: string, date: string,) : Promise<ActionResult>
```

### `internalSubAddItem` — function

```ts
async function internalSubAddItem(workspaceId: string, contractId: string, variantId: string, quantity: number,) : Promise<ActionResult>
```

### `internalSubAddOneTimeGift` — function

```ts
async function internalSubAddOneTimeGift(
  workspaceId: string, contractId: string, variantId: string, quantity: number,
  opts: { free?: boolean; priceCents?: number | null } = {},
) : Promise<ActionResult>
```

Append a **one-time** item to the sub's next renewal that ships once then drops off. Always appends a NEW line (never merges) so the gift sits alongside a recurring line for the same variant. `opts.free` defaults **true** → `is_gift:true` ($0 via the [[pricing]] engine); paid → `price_override_cents` from `priceCents` (or omitted → live catalog price). Every line carries `one_time_next_renewal:true`, which the [[../inngest/internal-subscription-renewals]] engine drops after the order ships. Requires the sub be `active`. Called by [[subscription-items]] `subAddOneTimeGift` (internal branch).

### `buildOneTimeGiftItem` — function (pure)

```ts
function buildOneTimeGiftItem(
  resolved: ResolvedVariant | null, fallbackVariantId: string, quantity: number,
  opts: { free?: boolean; priceCents?: number | null } = {},
) : Item
```

Pure record builder for the one-time line (free → `is_gift`; paid → `price_override_cents`; quantity floored ≥1; price clamped ≥0). Unit-tested in `internal-subscription.oneTimeGift.test.ts` (7 cases).

### `internalSubRemoveItem` — function

```ts
async function internalSubRemoveItem(workspaceId: string, contractId: string, variantId: string,) : Promise<ActionResult>
```

### `internalSubSwapVariant` — function

```ts
async function internalSubSwapVariant(workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string, quantity?: number,) : Promise<{ success: boolean; error?: string; priceGuardRefusal?: PriceGuardRefusal }>
```

**Price preservation is enforced by the SDK, not the caller.** A swap can LOWER a customer's price (a cheaper variant) but never RAISES it beyond what the pricing rules produce for the post-swap variant and quantity. The guard compares against the RULES-DERIVED expectation, not the captured-before price, so legitimate quantity-driven per-unit increases pass while catalog resets still fail loudly.

The SDK: (1) Reads the current sub's state, (2) computes the expected post-swap line price via [[../libraries/commerce__price]] `resolveSubscriptionPricing` on a hypothetical items array with the new variant and quantity, (3) performs the local DB swap, (4) asserts the observed post-swap realized price (re-priced through `resolveSubscriptionPricing` on the final items) against the expected via [[swap-price-assertion]] `assertSwapDidNotRaise` (2¢ tolerance for arithmetic-solve rounding; anything higher fails).

On refusal, returns a distinct `PriceGuardRefusal` object (not an error string) so upstream callers can distinguish a deliberate guard refusal from a real error. This closes the 2026-08-05 mislabel class where an internal-rail guard refusal (Isabel's internal contract `internal-8922b5701b2f45ea`, quantity 2→1 forfeiting buy-two) was incorrectly surfaced as an Appstle vendor error. Spec: [[../specs/swap-price-guard-compares-against-the-pricing-rules-not-the-old-price]].

### `internalSubUpdateLineItemPrice` — function

```ts
async function internalSubUpdateLineItemPrice(workspaceId: string, contractId: string, variantId: string, basePriceCents: number,) : Promise<ActionResult>
```

### `internalSubApplyDiscount` — function

```ts
async function internalSubApplyDiscount(
  workspaceId: string,
  contractId: string,
  discountCode: string,
  opts?: {
    resolved?: AppliedDiscountResolved | null;
    customerId?: string | null;
    skipRealValueVerify?: boolean;
  },
) : Promise<ActionResult>
```

Two behaviors changed by [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] (ticket `46a7aa75-9a09-4fbe-8aa5-fb58440f3f09`):

1. **Write the FULL resolved shape when we have one.** With `opts.resolved`, the entry is `{code, type, value, recurring_cycle_limit, remaining_cycles, source}` (matches `applyCouponToSub` at `src/lib/coupons.ts:518`) so `computeAppliedDiscountCents` can derive the renewal discount from the entry alone without a live re-resolve. Without `opts.resolved` (legacy callers), the historical `{title: CODE}` stub is preserved for back-compat via `buildAppliedDiscountEntry(null, code)`.
2. **Post-write verify — refuse a false success.** After the write (or an idempotent no-write on an already-present code), re-checks that the applied code resolves to real value: EITHER `opts.resolved.value > 0` OR a live `resolveCoupon(workspaceId, code, customerId)` returns a coupon with `value > 0`. When BOTH fail the entry is inert (a dead Shopify code will discount $0 at renewal) and the caller gets `{success:false, error:"applied_code_resolves_to_zero_value"}` so `apply_loyalty_coupon`'s regen self-heal can fire instead of leaving a stub on the sub. Set `opts.skipRealValueVerify=true` to preserve pre-fix behavior on legacy paths that never resolve.

Pure helpers extracted for unit tests (`src/lib/internal-subscription.applyDiscount.test.ts`):

- `buildAppliedDiscountEntry(resolved, fallbackCode)` — the write-shape decider.
- `appliedEntryHasRealValue(entry)` — true iff the entry itself carries a computable discount (`type` + numeric `value>0` + non-exhausted `remaining_cycles`); also used by `verifyLoyaltyCouponAppliedToContract` to short-circuit the live re-resolve when the entry is self-sufficient.

Loyalty-* routing: `subscriptionApplyCoupon`'s internal branch calls `ensureInternalLoyaltyCouponRow` in [[coupons]] before resolving a `LOYALTY-*` code — materializes the `loyalty_redemptions` row as an internal `coupons` row scoped to the contract owner (NET-ZERO on points; the row is durable across a Shopify delete of the original discount code, so renewal-time `resolveCoupon` step-1 wins).

### `AppliedDiscountResolved` — interface

```ts
interface AppliedDiscountResolved {
  code: string;
  type: "percentage" | "fixed_amount";
  value: number;
  recurring_cycle_limit: number | null;
  source: "internal" | "shopify";
}
```

Local subset of `ResolvedCoupon` in [[coupons]] — kept local to avoid an import cycle between `internal-subscription.ts` and `coupons.ts`.

### `buildAppliedDiscountEntry` — function (pure)

```ts
function buildAppliedDiscountEntry(
  resolved: AppliedDiscountResolved | null | undefined,
  fallbackCode: string,
) : Record<string, unknown>
```

### `appliedEntryHasRealValue` — function (pure)

```ts
function appliedEntryHasRealValue(entry: unknown) : boolean
```

### `internalSubRemoveDiscount` — function

```ts
async function internalSubRemoveDiscount(workspaceId: string, contractId: string, discountCodeOrId: string,) : Promise<ActionResult>
```

Filters `subscriptions.applied_discounts` case-insensitively across every stored shape (bare string · `{title}` · `{code}` · `{id}`). Shape tolerance is load-bearing: `internalSubApplyDiscount` writes `{title: CODE}`, but after `internal_subscription_renewal` rewrites the row the entry is stored as `{code: CODE}` — the pre-fix filter only knew `{title}` / `{id}`, so removing a coupon from a subscription that had billed once silently no-op'd and returned `{success:true}`, discounting every subsequent renewal until noticed by eye (spec derived from Randi Stier, ticket `c2bc8bd8-2aca-4eeb-968b-dd968a3d0dbc`, 2026-08-10). Returns `{success:false, error:'coupon_not_found'}` when the filter dropped nothing so a caller that just told a customer "removed" can find out it did not happen. Extracted pure helper `filterOutDiscount(applied, code) → {next, removed}` for unit tests (`src/lib/internal-subscription.removeDiscount.test.ts`).

### `filterOutDiscount` — function

```ts
function filterOutDiscount(applied: unknown, discountCodeOrId: string) : { next: Array<Record<string, unknown>>; removed: boolean }
```

Pure filter behind `internalSubRemoveDiscount`. Matches every stored shape case-insensitively (bare string · `{title}` · `{code}` · `{id}`); returns `removed:true` iff at least one entry was dropped. The bare-string case coerces to `{title: <string>}` so the returned `next` is uniform for the JSONB write.

### `internalSubNotYetSupported` — function

```ts
function internalSubNotYetSupported(action: string) : ActionResult
```

## Callers

- `src/lib/appstle.ts`
- `src/lib/subscription-items.ts` — every internal short-circuit for line-item mutations, plus `internalSubApplyDiscount` / `internalSubRemoveDiscount` under the `subscriptionApplyCoupon` / `subscriptionRemoveCoupon` dispatcher

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
