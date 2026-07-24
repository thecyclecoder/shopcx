/**
 * Order/sub-scoped loyalty-ceiling guards
 * (loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 2).
 *
 * Phase 1 caps a SINGLE redemption at $15. Phase 2 closes the two remaining
 * ways the ceiling could be exceeded by COMBINING otherwise-in-cap actions:
 *
 *   1. `hasLoyaltyCodeApplied` — refuse a loyalty cash refund on an order
 *      that already consumed a LOYALTY-* coupon at checkout (wired into
 *      `redeem_points_as_refund` right after the order lookup).
 *
 *   2. `subscriptionHasLoyaltyCoupon` — refuse a second LOYALTY-* coupon on
 *      a contract already carrying one (wired into `apply_loyalty_coupon`
 *      before the mint/apply path).
 *
 * Both predicates are tolerant of the shapes seen in the wild:
 *   - orders.discount_codes JSONB — array of {code, amount, type} rows from
 *     Shopify (see supabase/migrations/20260331000001_orders_discount_codes.sql)
 *   - subscriptions.applied_discounts JSONB — array of {title, ...} objects
 *     (see supabase/migrations/20260403400000_subscription_discounts.sql;
 *      projected via `.title` in src/lib/research/probes/subscription.ts)
 *
 *   npx tsx --test src/lib/action-executor.loyalty-order-stacking-guards.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  hasLoyaltyCodeApplied,
  subscriptionHasLoyaltyCoupon,
} from "./action-executor";

// ── hasLoyaltyCodeApplied ─────────────────────────────────────────────

test("hasLoyaltyCodeApplied: LOYALTY-* code in the order's discount_codes → TRUE (block the second loyalty benefit)", () => {
  assert.equal(
    hasLoyaltyCodeApplied([
      { code: "LOYALTY-15-ABC123", amount: 15, type: "fixed_amount" },
    ]),
    true,
  );
});

test("hasLoyaltyCodeApplied: legacy smile-* code (migrated Smile.io redemption) → TRUE", () => {
  assert.equal(
    hasLoyaltyCodeApplied([{ code: "smile-abc-15", amount: 15 }]),
    true,
  );
});

test("hasLoyaltyCodeApplied: only non-loyalty codes (WELCOME10, SUMMER-SALE) → FALSE (the loyalty refund is legitimate)", () => {
  assert.equal(
    hasLoyaltyCodeApplied([
      { code: "WELCOME10", amount: 5 },
      { code: "SUMMER-SALE", amount: 3 },
    ]),
    false,
  );
});

test("hasLoyaltyCodeApplied: empty array / null / undefined / missing column → FALSE (fail-open on a fresh order)", () => {
  assert.equal(hasLoyaltyCodeApplied([]), false);
  assert.equal(hasLoyaltyCodeApplied(null), false);
  assert.equal(hasLoyaltyCodeApplied(undefined), false);
});

test("hasLoyaltyCodeApplied: malformed shapes (non-array, non-string entries, missing code) never crash", () => {
  assert.equal(hasLoyaltyCodeApplied("LOYALTY-15-ABC"), false); // top-level string is not the shape
  assert.equal(hasLoyaltyCodeApplied({ code: "LOYALTY-15-ABC" }), false); // object not wrapped in array
  assert.equal(hasLoyaltyCodeApplied([42, null, { amount: 5 }]), false);
  assert.equal(hasLoyaltyCodeApplied([{ code: 12345 }]), false); // non-string code
});

test("hasLoyaltyCodeApplied: string-only entries (some feeds project only the code string) → TRUE for LOYALTY-*", () => {
  assert.equal(hasLoyaltyCodeApplied(["LOYALTY-15-XYZ"]), true);
  assert.equal(hasLoyaltyCodeApplied(["WELCOME10", "LOYALTY-10-QRS"]), true);
});

test("hasLoyaltyCodeApplied: case-insensitive on the LOYALTY- prefix", () => {
  assert.equal(hasLoyaltyCodeApplied([{ code: "loyalty-15-abc" }]), true);
});

// ── subscriptionHasLoyaltyCoupon ──────────────────────────────────────

test("subscriptionHasLoyaltyCoupon: a LOYALTY-* discount already attached → TRUE (block the stacking attempt)", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ title: "LOYALTY-15-ABC123" }]),
    true,
  );
});

test("subscriptionHasLoyaltyCoupon: only a non-loyalty discount (SAVE10) → FALSE (the fresh apply is legitimate)", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ title: "SAVE10" }, { title: "SUMMER" }]),
    false,
  );
});

test("subscriptionHasLoyaltyCoupon: no active discounts → FALSE", () => {
  assert.equal(subscriptionHasLoyaltyCoupon([]), false);
  assert.equal(subscriptionHasLoyaltyCoupon(null), false);
});

test("subscriptionHasLoyaltyCoupon: mixed shapes tolerated — `title` OR `code` OR bare string", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ code: "LOYALTY-15-QQ" }]),
    true,
  );
  assert.equal(subscriptionHasLoyaltyCoupon(["LOYALTY-15-QQ"]), true);
});

test("subscriptionHasLoyaltyCoupon: garbage entries never crash", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([null, 42, { title: null }, {}]),
    false,
  );
});

test("subscriptionHasLoyaltyCoupon: legacy smile-* discount → TRUE", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ title: "smile-abc-15" }]),
    true,
  );
});

// ── Interaction pin: the two guards together close the combine-past-cap vector

test("Phase 2 invariant: an order carrying a $15 LOYALTY-* AND a sub carrying a $15 LOYALTY-* — both guards TRUE, both handlers must refuse", () => {
  const alreadyLoyaltyOrder = [
    { code: "LOYALTY-15-CHECKOUT", amount: 15, type: "fixed_amount" },
  ];
  const alreadyLoyaltySub = [{ title: "LOYALTY-15-ATTACHED" }];
  assert.equal(hasLoyaltyCodeApplied(alreadyLoyaltyOrder), true);
  assert.equal(subscriptionHasLoyaltyCoupon(alreadyLoyaltySub), true);
});
