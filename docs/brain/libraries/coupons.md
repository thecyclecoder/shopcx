# libraries/coupons

Discount-code resolver and applier — our own internal coupons plus fallback to Shopify discount codes. Internal wins first (step 1 in `resolveCoupon`). See [[../tables/coupons]] for schema and derived-code (master+suffix) pattern.

**File:** `src/lib/coupons.ts`

## File header

```
Coupon resolution and application engine.

The coupon resolver lives here; every `subscriptionApplyCoupon` /
`subscriptionRemoveCoupon` call dispatches to the Appstle or internal
path (per `is_internal`), and both resolve the code via this module.

Discounts are entire-order scoped (we ignore Shopify product scope for
internal subs) and stack on subscribe-and-save + quantity break.

For internal subscriptions, `resolveCoupon` checks our own `coupons`
table first (step 1: internal), then falls back to a real-time Shopify
lookup (step 2: Shopify). Loyalty-* codes are materialized as internal
coupons via `ensureInternalLoyaltyCouponRow` before resolve so that
`resolveCoupon` step-1 wins at renewal even if the Shopify code is
deleted or expired.
```

## Exports

### `resolveCoupon` — function

```ts
async function resolveCoupon(
  workspaceId: string,
  code: string,
  customerId?: string | null,
): Promise<ResolvedCoupon | null>
```

Resolve a discount code to a coupon object (code, type, value, recurring_cycle_limit, source). Steps:
1. **Internal lookup** — our own `coupons` table (`code` case-insensitive, exact-match). Skips master rows on direct match; only resolves masters via the derived `PREFIX-shortcode` path.
2. **Shopify fallback** — real-time workspace credentials lookup on `shopify_discount_id`.
3. **Failure** — returns null if both fail.

Derived codes bind to customer: `PREFIX-shortcode` rejects if `customerId` is absent or doesn't match the suffix-resolved customer. See [[../tables/coupons]] "Master coupons" for master/derived semantics.

### `applyCouponToSub` — function

```ts
async function applyCouponToSub(
  workspaceId: string,
  contractId: string,
  code: string,
  customerId?: string | null,
): Promise<{ success: boolean; error?: string } | null>
```

Resolve the code and append `{ code, type, value, recurring_cycle_limit, remaining_cycles, source }` to [[../tables/subscriptions]].`applied_discounts` (JSONB array). See `computeAppliedDiscountCents` for how renewal-time discount derives from this entry.

### `recordCouponRedemption` — function

```ts
async function recordCouponRedemption(
  workspaceId: string,
  customerId: string,
  code: string,
): Promise<void>
```

Write a [[../tables/coupon_redemptions]] ledger row (one per actual redemption). Called on order ingest when a code is successfully used, and on refund when a refund is issued.

### `removeCouponFromSub` — function

```ts
async function removeCouponFromSub(
  workspaceId: string,
  contractId: string,
  discountCodeOrId: string,
): Promise<{ success: boolean; error?: string }>
```

Filter `applied_discounts` by code or id (case-insensitive, all stored shapes). Returns `{success:false, error:'coupon_not_found'}` if the filter dropped nothing (caller can detect the remove failed).

### `computeAppliedDiscountCents` — function (pure)

```ts
function computeAppliedDiscountCents(
  appliedDiscounts: Array<Record<string, unknown>> | null,
  subtotalCents: number,
): { discountCents: number; nextAppliedDiscounts: Array<Record<string, unknown>> }
```

Compute the entire-order discount and return the next-state array with cycles decremented and exhausted entries dropped. Called at renewal time by [[../inngest/internal-subscription-renewals]].

## Loyalty-coupon materialization

### `isCanonicalLoyaltyCode` — function (pure)

```ts
function isCanonicalLoyaltyCode(code: unknown): boolean
```

Pure guard: true iff `code` matches the canonical LOYALTY-* shape `/^LOYALTY-\d{1,3}-[A-Za-z0-9]{6}$/i`. Rejects non-strings, nulls, empties, wildcards (`%`, `_`, `\`), partial prefixes, and out-of-spec lengths. Defense-in-depth: the caller gate (e.g., `subscriptionApplyCoupon`) is expected to check this too; this refuses injection payloads upfront so no malformed code reaches the materializer. Added by [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] Phase 2 Fix 1 (security).

### `escapeIlikeWildcards` — function (pure)

```ts
function escapeIlikeWildcards(input: string): string
```

Escape PostgreSQL LIKE wildcards (`%`, `_`) and backslash so an `.ilike("col", escapeIlikeWildcards(input))` behaves as literal case-insensitive equality. Belt-and-braces layer: a canonical code has no wildcards in it, so this is a no-op on the happy path — but guards against future caller-gate drift. Backslash replaced first (no double-escape). Added by [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] Phase 2 Fix 1 (security).

### `isRedemptionStateApplyEligible` — function (pure)

```ts
function isRedemptionStateApplyEligible(
  redemption: {
    status: string;
    used_at: string | null;
    expires_at: string | null;
  },
  now: Date = new Date(),
): boolean
```

Pure guard: true iff the `loyalty_redemptions` row is currently apply-eligible — `status='active'` AND `used_at IS NULL` AND (`expires_at IS NULL` OR `expires_at > now`). Boundary: `expires_at == now` is treated as expired (fail-closed, no race at the instant it expires). Used by `ensureInternalLoyaltyCouponRow` to refuse materializing a stale/consumed/expired redemption as a fresh internal coupon (Phase 3 Fix 2: coupon-replay defense). Added by [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] Phase 3 Fix 2 (security).

### `ensureInternalLoyaltyCouponRow` — function

```ts
async function ensureInternalLoyaltyCouponRow(
  workspaceId: string,
  code: string,
  contractOwnerCustomerId: string,
): Promise<ResolvedCoupon | null>
```

Materialize a LOYALTY-* code as an internal `coupons` row scoped to the contract-owning customer. Idempotent — an existing row keyed by `(workspace_id, lower(code))` unique index is returned as-is with no re-write. Returns `null` if no source `loyalty_redemptions` row exists, or if ownership/state guards fail.

**Why:** LOYALTY-* codes are minted in Shopify by `redeem_points`, so renewal-time `resolveCoupon` reaches Shopify step (step 3) to re-hydrate them. A deleted/dying Shopify code returns null → renewal charges full price. Materializing the redemption as an internal coupon moves resolution to step 1 (internal wins), surviving Shopify deletes.

**NET-ZERO on points:** Reads `loyalty_redemptions.discount_value` only; never calls `spendPoints`. Points were already spent at redeem time.

**Rails preserved:** `single_use=true` + `recurring_cycle_limit=1` = one charge, one loyalty coupon per renewal ceiling (mirrors Shopify-side `usageLimit=1`).

**Ownership guard (Phase 3 Fix 2):** Loads the redemption's `loyalty_members` row and requires `member.customer_id === contractOwnerCustomerId`. Fallback: when the member has no native `customer_id`, compares `member.shopify_customer_id` to contract owner's `shopify_customer_id` (single customers lookup). No link-group expansion — a coupon minted for a sibling profile does NOT transfer to another profile's contract (matches the Shopify-side customer binding).

**State guard (Phase 3 Fix 2):** Calls `isRedemptionStateApplyEligible` to refuse materializing stale/consumed/expired redemptions as fresh single-use coupons (coupon-replay defense).

**Canonical-shape guard (Phase 2 Fix 1):** Calls `isCanonicalLoyaltyCode` upfront so a wildcard payload (e.g., `LOYALTY-%`) is rejected before the materializer runs.

**Wildcard-escaping guard (Phase 2 Fix 1):** Both `.ilike()` calls use `escapeIlikeWildcards(code)` so any future caller-gate drift still can't reach wildcard-match.

Wired by `subscriptionApplyCoupon` (internal branch) before resolving a `LOYALTY-*` code. Added by [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] Phases 2–3.

### `insertInternalLoyaltyCouponRowUnchecked` — function

```ts
async function insertInternalLoyaltyCouponRowUnchecked(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  code: string,
  contractOwnerCustomerId: string,
  valueCents: number,
): Promise<ResolvedCoupon | null>
```

LOW-LEVEL insert — writes directly to `coupons` with `single_use=true`, `recurring_cycle_limit=1`, `type='fixed_amount'`, `customer_id=contractOwnerCustomerId`. ⚠️ UNCHECKED: bypasses the canonical-shape / owner-match / state-eligibility guards that `ensureInternalLoyaltyCouponRow` uses to defend the online `subscriptionApplyCoupon` path.

**ONLY callable from:**
- `ensureInternalLoyaltyCouponRow` itself (which pre-verifies).
- A **NAMED, one-customer ship-time remediation script** (e.g., `scripts/_backfill-brittany-loyalty-15-internal-coupon-46a7aa75.ts`) that has already resolved a specific historical redemption and verified the contract owner out-of-band (per CS-Director spec write-up).

Do NOT expose to any request-time or agent-driven caller. Returns null on unique-index conflict; caller re-reads the row. Added by [[../specs/loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value]] Phase 3 Fix 2.

## Callers

- `src/lib/subscription-items.ts` — `subscriptionApplyCoupon` / `subscriptionRemoveCoupon` dispatcher (internal short-circuits call `ensureInternalLoyaltyCouponRow` then resolve).
- `src/lib/action-executor.ts` — `apply_loyalty_coupon` action executor.
- `src/lib/internal-subscription.ts` — `internalSubApplyDiscount` (internal-branch renderer).

## Gotchas

- **Canonical LOYALTY codes only.** `subscriptionApplyCoupon` gates on `isCanonicalLoyaltyCode` before calling `ensureInternalLoyaltyCouponRow`. The materializer has an inner check (defense-in-depth); the caller gate is expected to fire first.
- **Stale/consumed/expired redemptions refuse.** `ensureInternalLoyaltyCouponRow` calls `isRedemptionStateApplyEligible` so a `status != 'active'` / `used_at != null` / past `expires_at` redemption cannot be revived as a fresh single-use coupon on ANY customer's contract (coupon-replay defense). Ship-time one-customer remediations use the unchecked path.

---

[[../README]] · [[../tables/coupons]] · [[../tables/loyalty_redemptions]] · [[../tables/coupon_redemptions]] · [[../../CLAUDE]]
