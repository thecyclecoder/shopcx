# libraries/loyalty

Loyalty program: tier eligibility, point earn / spend, redemption tier resolution, coupon code generation.

**File:** `src/lib/loyalty.ts`

## File header

```
Core loyalty logic — earning, spending, validation, calculations.
Native engine: no third-party provider. All points managed in our DB,
redemptions create Shopify discount codes.
```

## Exports

### `getLoyaltySettings` — function

```ts
async function getLoyaltySettings(workspaceId: string) : Promise<LoyaltySettings>
```

### `getMember` — function

```ts
async function getMember(workspaceId: string, shopifyCustomerId: string,) : Promise<LoyaltyMember | null>
```

### `getMemberByCustomerId` — function

```ts
async function getMemberByCustomerId(workspaceId: string, customerId: string,) : Promise<LoyaltyMember | null>
```

### `getOrCreateMember` — function

```ts
async function getOrCreateMember(workspaceId: string, shopifyCustomerId: string, email: string,) : Promise<LoyaltyMember>
```

### `getRedemptionTiers` — function

```ts
function getRedemptionTiers(settings: LoyaltySettings) : RedemptionTier[]
```

### `validateRedemption` — function

```ts
function validateRedemption(member: LoyaltyMember, tier: RedemptionTier,) :
```

### `pointsToDollarValue` — function

```ts
function pointsToDollarValue(points: number, settings: LoyaltySettings) : number
```

### `calculateEarningPoints` — function

```ts
function calculateEarningPoints(lineItemsTotal: number, deductions: OrderDeductions, settings: LoyaltySettings,) : number
```

> **Balance mutators re-read the live row.** `earnPoints` / `spendPoints` / `deductPoints` each re-fetch the member's current `points_balance` (and `points_earned`/`points_spent`) from the DB before updating, rather than trusting the passed-in `member` snapshot — then they write the new values back onto the `member` object. This makes it safe to loop any of them over the same `member` object (e.g. crediting many orders in a backfill) without lost updates.

### `earnPoints` — function

```ts
async function earnPoints(member: LoyaltyMember, points: number, orderId: string | null, description: string,) : Promise<void>
```

### `spendPoints` — function

```ts
async function spendPoints(member: LoyaltyMember, points: number, description: string, shopifyDiscountId: string | null,) : Promise<void>
```

### `deductPoints` — function

```ts
async function deductPoints(member: LoyaltyMember, points: number, orderId: string | null, type: "refund" | "chargeback", description: string,) : Promise<void>
```

### `LoyaltyMember` — interface

### `RedemptionTier` — interface

### `LoyaltySettings` — interface

### `OrderDeductions` — interface

## Callers

- `src/app/api/loyalty/balance/route.ts`
- `src/app/api/loyalty/members/[memberId]/route.ts`
- `src/app/api/loyalty/redeem/route.ts`
- `src/lib/portal/handlers/loyalty-apply-subscription.ts`
- `src/lib/portal/handlers/loyalty-balance.ts`
- `src/lib/portal/handlers/loyalty-redeem.ts`
- `src/lib/shopify-webhooks.ts`

## Atomic redeem→apply contract

**Points are only ever spent when the coupon actually lands on the target.** The `redeem_points` → `apply_(loyalty_)coupon` pair is one unit: both succeed (coupon on target, points spent) or neither (points intact). Enforced in the orchestrator's direct-action executor, not here — this page is where the contract is documented; the code lives in `src/lib/action-executor.ts`.

**Two mechanisms, both in `action-executor.ts`:**

1. **Code threading fallback** — `substituteActionParams` (exported from action-executor). When the next action is `apply_loyalty_coupon` (or `apply_coupon`) and its `code` is missing / empty / still an unsubstituted `{{coupon_code}}` / `[COUPON_CODE]` token, the executor threads the `couponCode` from a prior successful `redeem_points` result directly. Sonnet does not need to remember the template — the code always makes it into the apply call. An explicit non-template code from Sonnet is respected (the fallback only fires when there is no real code).

2. **Rollback on apply failure** — `rollbackLoyaltyRedemptionOnApplyFailure` (exported from action-executor). Runs after `handleDirectAction`'s success + failure branches finalize. If a paired apply did not land — either the initial handler failed OR self-heal verify+retry gave up — the executor:
   - re-credits `redemption.points_spent` to the member via an `adjustment`-type row in `loyalty_transactions` + a live re-read of `points_balance` / `points_earned` before the update (matches `earnPoints`'s write shape without going through the helper, so the code path is unit-testable against an in-memory admin);
   - flips the `loyalty_redemptions` row from `active` → `rolled_back`;
   - emits a `[Rollback]` system note on the ticket for the audit trail.

   **Safety guard.** Rollback only touches an `active` row. The `apply_loyalty_coupon` handler's internal regen path (used when the original code is stale in Shopify) mutates the original row to `expired` when it re-mints — leaving non-active rows alone avoids double-refunding a regen sequence. If a regen-then-fail edge case surfaces, extend rollback to also target the newer active row.

**`loyalty_redemptions.status` values:** `active` (ready), `applied` (on subscription, waiting for charge), `used` (consumed on order), `expired` (past expiry or superseded by regen), `rolled_back` (re-credited after paired apply failed — Phase 1 of the atomic contract). Column is plain text, no CHECK constraint — see `supabase/migrations/20260708120000_loyalty_redemptions_rolled_back_status.sql` for the comment refresh.

**Tests.** `src/lib/action-executor.atomic-redeem-apply.test.ts` locks in both mechanisms (11 tests, in-memory fake admin), including the Judy scenario: redeem+apply chain with the apply handler returning "Missing coupon code" → points_balance restored, redemption row flipped `active` → `rolled_back`, adjustment transaction written, `[Rollback]` note emitted.

**Precedent.** Ticket `0a9e4d7f` (Judy — 1,500 pts spent, `LOYALTY-15-HC6UFJ` never applied because the redeem→apply chain ran without the `{{coupon_code}}` template). The manual remedy landed the coupon on her order-now; `scripts/reconcile-judy-loyalty-burn.ts` is the one-off closeout that verifies the spend is BACKED (no orphan, no double-charge) — read-only, prints a `RECONCILED` verdict or a drift report.

## Gotchas

- **Never mutate `loyalty_redemptions.status` to `rolled_back` directly.** The atomic contract flow re-credits points AND flips status in the same helper (`rollbackLoyaltyRedemptionOnApplyFailure`). Setting `status = 'rolled_back'` on its own leaves the ledger owing points that were never re-credited — a silent balance drift.
- **`earnPoints` instantiates its own admin client**, which is fine in production but breaks in-memory fake-admin tests. When you need a re-credit inline from a code path that must be unit-testable (the rollback helper), write the `adjustment` transaction + the balance update directly against the caller's admin. Same live-read pattern (`select points_balance, points_earned` before the update), just no `createAdminClient()` call.

---

[[../README]] · [[../../CLAUDE]]
