/**
 * Unit tests for `isRedemptionStateApplyEligible` — the pure state-check
 * predicate behind `ensureInternalLoyaltyCouponRow`'s Fix-2 guard. Spec:
 * loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value
 * § Phase 3 (Fix 2 — sec:real-vuln Authz/coupon-replay finding on
 * `src/lib/subscription-items.ts:1432` / `src/lib/coupons.ts:895-918`).
 *
 * Failing state closed by these tests: pre-Fix-2, the materializer would
 * insert an internal `coupons` row for a `loyalty_redemptions` row in ANY
 * state — used, expired, cancelled — as long as the code shape was
 * canonical. An attacker who knew a stale/consumed loyalty code from
 * another (or their own historical) redemption could revive it as a fresh
 * `single_use=true` internal coupon on their own contract, bypassing the
 * Shopify one-use / customer rails the previous resolver relied on.
 *
 * Run:
 *   npx tsx --test src/lib/coupons.redemptionEligibility.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isRedemptionStateApplyEligible } from "./coupons";

const FIXED_NOW = new Date("2026-08-29T12:00:00Z");

test("isRedemptionStateApplyEligible: status=active + no used_at + future expiry → true", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "active", used_at: null, expires_at: "2026-11-15T00:00:00Z" },
      FIXED_NOW,
    ),
    true,
  );
});

test("isRedemptionStateApplyEligible: status=active + no used_at + null expires_at → true (never-expires)", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "active", used_at: null, expires_at: null },
      FIXED_NOW,
    ),
    true,
  );
});

test("isRedemptionStateApplyEligible: status='used' → false (already consumed — coupon-replay guard)", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "used", used_at: null, expires_at: "2027-01-01T00:00:00Z" },
      FIXED_NOW,
    ),
    false,
  );
});

test("isRedemptionStateApplyEligible: status='expired' → false", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "expired", used_at: null, expires_at: "2027-01-01T00:00:00Z" },
      FIXED_NOW,
    ),
    false,
  );
});

test("isRedemptionStateApplyEligible: status='rolled_back' → false (all non-active states refused)", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "rolled_back", used_at: null, expires_at: "2027-01-01T00:00:00Z" },
      FIXED_NOW,
    ),
    false,
  );
});

test("isRedemptionStateApplyEligible: used_at set (even with status='active') → false", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "active", used_at: "2026-06-01T00:00:00Z", expires_at: "2027-01-01T00:00:00Z" },
      FIXED_NOW,
    ),
    false,
  );
});

test("isRedemptionStateApplyEligible: expires_at in the past → false", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "active", used_at: null, expires_at: "2026-01-01T00:00:00Z" },
      FIXED_NOW,
    ),
    false,
  );
});

test("isRedemptionStateApplyEligible: expires_at exactly at now → still considered expired (fail-closed)", () => {
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "active", used_at: null, expires_at: FIXED_NOW.toISOString() },
      FIXED_NOW,
    ),
    false,
  );
});

test("isRedemptionStateApplyEligible: expires_at 1s in the future → true", () => {
  const future = new Date(FIXED_NOW.getTime() + 1_000);
  assert.equal(
    isRedemptionStateApplyEligible(
      { status: "active", used_at: null, expires_at: future.toISOString() },
      FIXED_NOW,
    ),
    true,
  );
});

test("isRedemptionStateApplyEligible: defaults `now` to real clock when omitted (no-throw sanity)", () => {
  // We can't pin the runtime clock in a pure test — just prove the fn returns a boolean.
  const r = isRedemptionStateApplyEligible(
    { status: "active", used_at: null, expires_at: null },
  );
  assert.equal(typeof r, "boolean");
  assert.equal(r, true);
});
