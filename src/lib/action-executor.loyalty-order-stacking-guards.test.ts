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
  subscriptionLoyaltyCouponCodes,
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

// ── subscriptionLoyaltyCouponCodes — the same-vs-different-code split ─
// Spec: apply-loyalty-coupon-same-code-reapply-is-idempotent-success-not-stacking.
// A same-code re-apply is idempotent success (ticket be3d6ab7: the first
// apply landed LOYALTY-15-8M8HKP; the next three retries hit the coarse
// "already has a loyalty coupon" refusal → false escalation to June). The
// stacking-cap refusal must fire ONLY when a DIFFERENT LOYALTY-* code is
// on the sub (real single-$15 ceiling case the hard-cap spec intended).

test("subscriptionLoyaltyCouponCodes: extracts the LOYALTY-* codes uppercased for same-code comparison", () => {
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([{ title: "LOYALTY-15-ABC123" }]),
    ["LOYALTY-15-ABC123"],
  );
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([{ code: "loyalty-15-xyz" }]),
    ["LOYALTY-15-XYZ"],
  );
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes(["LOYALTY-10-QQ", "SAVE10"]),
    ["LOYALTY-10-QQ"],
  );
});

test("subscriptionLoyaltyCouponCodes: legacy smile-* included (same tolerant family)", () => {
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([{ title: "smile-abc-15" }]),
    ["SMILE-ABC-15"],
  );
});

test("subscriptionLoyaltyCouponCodes: no loyalty codes → [] (a fresh apply is legitimate — guard proceeds)", () => {
  assert.deepEqual(subscriptionLoyaltyCouponCodes([]), []);
  assert.deepEqual(subscriptionLoyaltyCouponCodes(null), []);
  assert.deepEqual(subscriptionLoyaltyCouponCodes([{ title: "SAVE10" }]), []);
});

test("subscriptionLoyaltyCouponCodes: multiple loyalty codes on the sub (pathological — a prior stacking bug leaked one through)", () => {
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([
      { title: "LOYALTY-15-AAA" },
      { title: "LOYALTY-15-BBB" },
    ]),
    ["LOYALTY-15-AAA", "LOYALTY-15-BBB"],
  );
});

test("apply_loyalty_coupon guard semantics: same code already on the sub → idempotent success (no different-code entry)", () => {
  const applied = [{ title: "LOYALTY-15-8M8HKP" }];
  const incoming = "LOYALTY-15-8M8HKP";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(existing.length, 1, "exactly one loyalty code present");
  assert.equal(different.length, 0, "no DIFFERENT loyalty code → guard returns success (ticket be3d6ab7 no longer re-escalates)");
});

test("apply_loyalty_coupon guard semantics: same-code re-apply is case-insensitive (Shopify may normalize case)", () => {
  const applied = [{ title: "loyalty-15-8m8hkp" }];
  const incoming = "LOYALTY-15-8M8HKP";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(different.length, 0);
});

test("apply_loyalty_coupon guard semantics: DIFFERENT loyalty code on the sub → refuse (the real single-$15 ceiling stacking case)", () => {
  const applied = [{ title: "LOYALTY-15-EXISTING" }];
  const incoming = "LOYALTY-15-INCOMING";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(different.length, 1, "a different loyalty code IS present — refuse stacks past the cap");
  assert.equal(different[0], "LOYALTY-15-EXISTING");
});

test("apply_loyalty_coupon guard semantics: same code PLUS a different loyalty code → refuse (the different one still means stacking)", () => {
  const applied = [{ title: "LOYALTY-15-SAME" }, { title: "LOYALTY-15-OTHER" }];
  const incoming = "LOYALTY-15-SAME";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(different.length, 1, "the OTHER loyalty code makes this a stacking case regardless of the SAME hit");
});

test("apply_loyalty_coupon guard semantics: no loyalty code on the sub → guard proceeds to the mint/apply path (existing = [])", () => {
  const applied = [{ title: "SAVE10" }];
  const incoming = "LOYALTY-15-FRESH";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  assert.equal(existing.length, 0, "no loyalty codes → this is a fresh apply, guard does not fire");
  // guard body only runs when existing.length > 0 — mirror the handler
  assert.ok(!(existing.length > 0));
});
