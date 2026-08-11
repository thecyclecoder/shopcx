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

Fills in `sku` / `image_url` rather than overwriting them — a caller that already mapped a sku off the Appstle payload keeps it, and a variant missing from `product_variants` keeps whatever it arrived with instead of being blanked.

### `mergeContractLineItems` — function (pure)

```ts
function mergeContractLineItems(priorItems: Record<string, unknown>[], lines: Record<string, unknown>[]) : Record<string, unknown>[]
```

The lossless half of `syncContractItems`. See § Lossless item sync.

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
- **Appstle sub** → a **standalone $0 gift order** via [[commerce__replacement|issueReplacement]] (`resolveShopifyVariantId` maps a UUID → numeric Shopify variant id first). **FREE only** — a paid add-on returns an error (`opts.free:false` on an Appstle sub is unsupported; use an internal sub or a charged order). Appstle's true one-off endpoint lives on `membership-admin.appstle.com` and **401s our Subscriptions API key**, and `replace-variants-v3` `newOneTimeVariants` adds a **RECURRING** $0 line (the ticket `6a8ddfd9` double-frother incident) — so the gift ships as its **own $0 order** alongside the next renewal: never recurs, never charges, no portal-editable line. **Idempotent** — before issuing it queries `replacements` for a non-`failed` `reason='goodwill gift'` row on the same sub carrying this variant in the last hour, and **skips** if found, so a verify-in-DB self-heal retry can't double-order. Country code is derived from the customer's `default_address.countryCodeV2` (not the shared shipping resolver, which can hand back a truncated `"UN"` that `normalizeCountryToIso2` lets pass). The `add_one_time_gift` [[action-executor]] `verifyActionInDB` case is **handler-authoritative** (`return true`) — subAddOneTimeGift verifies its own success across both backends' storage shapes, and a single items-based predicate false-negatived the Appstle gift-order path (which leaves `subscriptions.items` untouched) and triggered the double-delivery.

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

### `couponApplicableToSubStatus` — function (pure guard)

```ts
function couponApplicableToSubStatus(status: string | null | undefined): boolean
```

Predicate that checks if a subscription is eligible for coupon application. Returns `true` only if the subscription status is `'active'`. Refuses to apply any loyalty/coupon discount to subscriptions with status `'paused'`, `'cancelled'`, or null — these statuses indicate the subscription cannot receive charges, so a discount is invalid. Wired into both `subscriptionApplyCoupon` (internal-aware dispatcher) and `applyCouponToSub` (coupons.ts), closing the SC135320 double-payout defect where a dangling coupon was applied to a paused subscription.

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

### `checkContractSatisfiesExpectation` — function (pure)

```ts
type MutationExpectation =
  | { kind: "add"; variantId: string; quantity: number }
  | { kind: "remove"; variantId: string }
  | { kind: "swap"; newVariantId: string; oldVariantId: string; quantity: number }
  | { kind: "price"; variantId: string; expectedBaseCents: number };

function checkContractSatisfiesExpectation(
  lines: Array<{ variantId?: string; quantity?: number; pricingPolicy?: { basePrice?: { amount?: string } | null } | null }>,
  expected: MutationExpectation,
): { ok: boolean; reason?: string }
```

Pure predicate — does the live Appstle contract's `lines.nodes` snapshot satisfy the caller's mutation expectation? Broken out of the mutation helpers so the classification can be unit-tested (`src/lib/subscription-items.verifyEndState.test.ts`) without standing up a live vendor mock; the I/O wrapper `verifyContractEndState` polls this against the real contract with a bounded settle window. Returns `{ ok: true }` when satisfied, else `{ ok: false, reason }` naming the expectation and what the contract actually holds so the caller's error string is diagnosable at a glance.

- **`add`** — variant present at ≥ requested quantity (Appstle merges an add into an existing line, so quantity is a lower bound not equality).
- **`remove`** — variant absent from the contract.
- **`swap`** — the new variant present at ≥ requested quantity AND the old variant absent (a swap that added the new but left the old is a partial apply, not a success — the exact shape of the 2026-07-30 crisis).
- **`price`** — the line for `variantId` carries `pricingPolicy.basePrice` matching `expectedBaseCents` (±$0.01 tolerance for float→cents rounding across the API boundary).

### Phase 1 — every mutation verifies its end state before returning success

`subAddItem`, `appstleRemoveLineItem` / `subRemoveItem`, `subChangeQuantity`, `subSwapVariant` (identity check — new present + old absent for a genuine swap; variant present at ≥ requested quantity for a **self-swap** — see below) and `subUpdateLineItemPrice` all re-read the LIVE Appstle contract after their upstream call succeeds and gate their `success: true` return on `checkContractSatisfiesExpectation`. `syncItemsAfterMutation` / `syncContractItems` fires ONLY on verified success — writing the intended state into our own `subscriptions.items` mirror on an unverified mutation is what makes the upstream lie durable.

**Self-swap = pure quantity change.** [[action-executor]] `change_quantity` calls `subSwapVariant(_, _, v, v, qty)` (old === new). The strict `swap` verdict — "new present AND old absent" — can NEVER hold on a self-swap (the old variant is the new variant), so the identity verdict would always false-fail. The false failure skips `syncItemsAfterMutation` AND the `capturedUnitCents` re-apply below it, silently resetting the grandfathered price to catalog. `identityExpectationForSwap(oldVariantId, newVariantId, quantity)` (pure helper) resolves this: when `old === new` it picks `{ kind: 'add', variantId, quantity }` (variant present at ≥ requested quantity — the only meaningful post-condition for a quantity change); otherwise it keeps the strict `swap` verdict so the 2026-07-30 partial-apply still fails loudly. Spec: [[../specs/change-quantity-self-swap-false-fails-identity-verdict]].

A bounded settle window (`APPSTLE_MUTATION_VERIFY_ATTEMPTS`, default 3, and `APPSTLE_MUTATION_VERIFY_DELAY_MS`, default 400ms — worst-case ≈ 800ms wait) accommodates Appstle's asynchronous apply, but a TIMEOUT ends as FAILURE, never an assumed success. Unverifiable is NOT the same as done — the caller should retry or escalate rather than record a lie.

**Why:** `callReplaceVariants` decides success purely from `res.ok`. Appstle answers 200 on requests it then declines to apply — reproduced on contracts `27946909869` and `27871477933` (2026-07-30) where a swap reported success and the flavour never moved. A false success is worse than a failure: a failure retries, a false success is recorded as done and the customer ships the wrong thing.

### `subSwapVariant` — function

```ts
async function subSwapVariant(workspaceId: string, contractId: string, oldVariantId: string, newVariantId: string, quantity: number = 1,) : Promise<{ success: boolean; error?: string; newLineGid?: string; permanent?: boolean; declineErrorKey?: string; priceGuardRefusal?: PriceGuardRefusal }>
```

**Price preservation is enforced by the SDK, not the caller.** A swap can LOWER a customer's price (a cheaper variant) but never RAISES it beyond what the pricing rules produce for the post-swap variant and quantity. The guard compares against the RULES-DERIVED expectation, not the captured-before price, so legitimate quantity-driven per-unit increases pass (dropping qty from 2 to 1 forfeits the buy-two break, so per-unit price correctly goes up) while catalog resets still fail loudly.

The SDK: (1) Computes the expected post-swap line price via [[../libraries/commerce__price]] `resolveSubscriptionPricing` on the post-swap items (variant + quantity), (2) calls `callReplaceVariants` to perform the swap, (3) reads back the observed post-swap realized price (Appstle: reads live `contract-external` and prefers `pricingPolicy.basePrice × (1 − sns)` over `currentPrice.amount`; internal: re-prices the final items via `resolveSubscriptionPricing` on the new line), (4) asserts the observed against expected via [[swap-price-assertion]] `assertSwapDidNotRaise` (2¢ tolerance for arithmetic-solve rounding; anything higher fails with a message naming contract, expected, observed, and quantity).

On refusal, the SDK returns a distinct `PriceGuardRefusal` object (not an error string) so the [[../libraries/portal/helpers]] `handlePriceGuardRefusal` can classify it honestly (status 422, error code `price_guard_refusal`, not `appstle_error` — a guard refusal is US deliberately declining, not a vendor fault) and render a customer-facing message via `describePriceGuardRefusal` that explains the per-unit increase and attributes it to a forfeited discount when applicable.

This closes the 2026-07-30 crisis class where `callReplaceVariants` returned 2xx-success on a contract that reset $286-worth of grandfathered prices to catalog, and the 2026-08-05 mislabel class where an internal-rail guard refusal was surfaced as an Appstle vendor error. Spec: [[../specs/swap-price-guard-compares-against-the-pricing-rules-not-the-old-price]].

### `subscriptionApplyCoupon` — function

```ts
async function subscriptionApplyCoupon(workspaceId: string, contractId: string, code: string,) : Promise<{ success: boolean; error?: string }>
```

Internal-aware coupon apply. Guarded by `couponApplicableToSubStatus` — refuses application to non-active subscriptions, returning `{ success: false, error: 'subscription_not_active' }`. For active subs: Internal subs: `resolveCoupon` (internal wins → Shopify fallback) → `internalSubApplyDiscount` writes `subscriptions.applied_discounts`. Appstle subs: `healOnTouch` → `applyDiscountWithReplace`. Closes SC135320 — a discount on a paused/cancelled sub is never valid and silently discounts a future renewal the customer didn't earn.

### `subscriptionRemoveCoupon` — function

```ts
async function subscriptionRemoveCoupon(workspaceId: string, contractId: string, discountIdOrCode: string,) : Promise<{ success: boolean; error?: string }>
```

Internal-aware coupon remove. Internal subs: `internalSubRemoveDiscount` — filters `subscriptions.applied_discounts` case-insensitively across every stored shape (bare string · `{title}` · `{code}` · `{id}`) because a coupon rewritten as `{code}` by `internal_subscription_renewal` has to remove too, and returns `{success:false, error:'coupon_not_found'}` when the filter dropped nothing so the caller does not report a false success (spec derived from Randi Stier 2026-08-10; pre-fix the filter only knew `{title}`/`{id}` and returned `{success:true}` unconditionally, discounting every renewal until noticed by eye). Appstle subs: `healOnTouch` → `removeExistingDiscounts` (1-coupon-per-sub, so `discountIdOrCode` is only consulted for the internal filter).

## Callers

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts`
- `src/app/api/workspaces/[id]/crisis/[crisisId]/auto-swap/route.ts`
- `src/app/api/workspaces/[id]/subscriptions/[subId]/coupon/route.ts` — `subscriptionApplyCoupon` (POST) / `subscriptionRemoveCoupon` (DELETE)
- `src/app/api/workspaces/[id]/subscriptions/[subId]/items/route.ts`
- `src/lib/action-executor.ts` — `subscriptionApplyCoupon` (apply_coupon + apply_loyalty_coupon) / `subscriptionRemoveCoupon` (remove_coupon)
- `src/lib/portal/handlers/remove-line-item.ts`
- `src/lib/portal/handlers/replace-variants.ts`

## Lossless item sync

`syncContractItems` runs after EVERY verified Appstle line mutation and rewrites `subscriptions.items`. Anything it fails to carry forward is destroyed on the customer's live subscription, so it MERGES and never replaces.

**Appstle owns** what the contract-external line node actually returns: which lines exist, `quantity`, `currentPrice`, `sku`, `sellingPlanName`, `variantImage.url`, `variantId`, `productId`, `id`. **We own** local-only enrichment Appstle has never heard of: `is_gift`, `price_override_cents`, `one_time_next_renewal`. Two of ours decide what the customer is charged.

`mergeContractLineItems` keys prior items by **`line_id`, never `variant_id`** — a subscription can legitimately hold two lines of the same variant (7 active subs did during the 2026-08-11 ACV sweep), and a variant key collapses them, copying one line's gift flag or price override onto the other. Local keys merge UNDER the Appstle-owned block, so Appstle wins on what it owns and any local key survives by default — including keys added later.

**Ground truth for why this matters.** Before 2026-08-11 the mapper simply never read `node.sku`, even though Appstle returns it. Every sub touched by any line mutation silently lost the skus on its remaining lines. A SKU-keyed sweep of ACV Gummies consequently found **8 subscriptions instead of 307** — the survivors were the ones that had never been mutated. The same omission overwrote our `product_id` UUID with Appstle's Shopify numeric, which is why UUID-keyed queries missed them too.

**Two guards ride along:**
- **Never blank a non-empty list.** A 200 carrying zero lines is indistinguishable from a contract Appstle has moved or dropped. Writing `[]` yields a subscription that renews billing shipping + protection with no product to ship — the SHOPCX171 empty-cart renewal (2026-08-07, refunded). The sync bails and leaves the last good snapshot, logging a warn.
- **Workspace-scoped write.** The update carries `.eq("workspace_id", …)` alongside the contract id; `shopify_contract_id` alone is not a tenant-safe predicate in a multi-tenant table.

`resolveVariantTitles` reads the first-class `product_variants` table (matching `shopify_variant_id` for the Appstle rail OR `id` for the internal rail) rather than the legacy `products.variants` jsonb blob, and returns `sku` + `image_url` so a brand-new line with no prior item to merge from still lands with a sku. Coverage is not total — a variant absent from `product_variants` resolves to nothing and keeps its payload values.

## Gotchas

- **`couponApplicableToSubStatus` guards both coupon-apply entry points.** `subscriptionApplyCoupon` and `applyCouponToSub` both check the subscription status before apply — refusing `'paused'`, `'cancelled'`, or null. Discounts on non-active subs silently discount a future renewal the customer didn't earn (ticket f9e28d57, Cora: $15 coupon + $15 cash payout from one 1,500-pt redemption). Both return `{ success: false, error: 'subscription_not_active' }` on a non-active sub.
- `subUpdateLineItemPrice` has the 0.75 SubSave multiplier **baked in** — pass the visible MSRP, the helper applies × 0.75 before sending to Appstle. If you compute the SubSave price first, you'll end up at 0.5625 of MSRP.
- Every helper checks `isInternalSubscription()` first. Internal subs bypass Appstle.
- Variant ids must be Shopify variant ids when crossing into Appstle — internal UUIDs won't work.
- `subUpdateLineItemPrice` is the **restore-the-grandfathered-base** step of subscription overcharge remediation ([[subscription-overcharge]]): it heals the Appstle sub in place (`healOnTouch` first) or sets `price_override_cents` for internal subs. The `update_line_item_price` direct action ([[action-executor]]) now **routes internal subs first** (before the Appstle config/lineId fetch, which would fail with "Appstle not configured" for an internal sub).
- `appstleRemoveLineItem` recognizes Appstle's **own last-item guardrail**: a `400` whose body matches `"must be present in a subscription"` / `"UserGeneratedError"` (Appstle refuses to remove the last recurring product). This is logged at `console.warn` (not `console.error`) and returned as `{ success: false, error: "would_remove_last_item" }` — the same friendly outcome [[portal__handlers__remove-line-item]]'s local pre-check produces. Without this, a stale-high local items snapshot would let the removal slip past the pre-check and Appstle's 400 would surface as a logged ERR + opaque 502 (Control Tower signature `vercel:0dda1c7b9495ebb1`). The handler maps `would_remove_last_item` straight to its friendly 400.

---

[[../README]] · [[../../CLAUDE]]
