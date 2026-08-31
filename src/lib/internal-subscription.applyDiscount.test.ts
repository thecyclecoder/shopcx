/**
 * Unit tests for `buildAppliedDiscountEntry` + `appliedEntryHasRealValue` —
 * the pure shape helpers behind `internalSubApplyDiscount`. Spec:
 * loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value
 * (ticket 46a7aa75). Pre-fix `internalSubApplyDiscount` wrote `{title: CODE}`
 * for every code and returned success unconditionally — a dead Shopify code
 * silently discounted $0 at renewal because `computeAppliedDiscountCents`
 * requires `type` + `value` to derive a real amount and skips a stub entry
 * as "legacy/code-only".
 *
 * Run:
 *   npx tsx --test src/lib/internal-subscription.applyDiscount.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAppliedDiscountEntry,
  appliedEntryHasRealValue,
} from "./internal-subscription";

test("buildAppliedDiscountEntry with a full ResolvedCoupon → full-shape entry", () => {
  const entry = buildAppliedDiscountEntry(
    {
      code: "LOYALTY-15-UP77G3",
      type: "fixed_amount",
      value: 1500, // cents
      recurring_cycle_limit: 1,
      source: "internal",
    },
    "LOYALTY-15-UP77G3",
  );
  assert.deepEqual(entry, {
    code: "LOYALTY-15-UP77G3",
    type: "fixed_amount",
    value: 1500,
    recurring_cycle_limit: 1,
    remaining_cycles: 1,
    source: "internal",
  });
});

test("buildAppliedDiscountEntry with null resolved → legacy {title} stub (pre-fix fallback)", () => {
  const entry = buildAppliedDiscountEntry(null, "PROMO20");
  assert.deepEqual(entry, { title: "PROMO20" });
});

test("appliedEntryHasRealValue: full-shape fixed_amount → true", () => {
  assert.equal(
    appliedEntryHasRealValue({
      code: "LOYALTY-15-UP77G3",
      type: "fixed_amount",
      value: 1500,
      remaining_cycles: 1,
      source: "internal",
    }),
    true,
  );
});

test("appliedEntryHasRealValue: {title:CODE} stub → false (the pre-fix write shape)", () => {
  // The exact failing state from ticket 46a7aa75: internalSubApplyDiscount
  // wrote this and returned success, so renewal-time discount was $0.
  assert.equal(appliedEntryHasRealValue({ title: "LOYALTY-15-UP77G3" }), false);
});

test("appliedEntryHasRealValue: bare string entry → false", () => {
  assert.equal(appliedEntryHasRealValue("LOYALTY-15-UP77G3"), false);
});

test("appliedEntryHasRealValue: {code, type, value:0} → false (would discount nothing)", () => {
  assert.equal(
    appliedEntryHasRealValue({
      code: "LOYALTY-15-UP77G3",
      type: "fixed_amount",
      value: 0,
      remaining_cycles: 1,
    }),
    false,
  );
});

test("appliedEntryHasRealValue: {code, type, value, remaining_cycles:0} → false (already exhausted)", () => {
  assert.equal(
    appliedEntryHasRealValue({
      code: "LOYALTY-15-UP77G3",
      type: "fixed_amount",
      value: 1500,
      remaining_cycles: 0,
    }),
    false,
  );
});

test("appliedEntryHasRealValue: full-shape with remaining_cycles:null (forever) → true", () => {
  assert.equal(
    appliedEntryHasRealValue({
      code: "MAKER50",
      type: "percentage",
      value: 50,
      remaining_cycles: null,
      source: "internal",
    }),
    true,
  );
});

test("appliedEntryHasRealValue: {code, type, value} but no remaining_cycles → true (null default)", () => {
  assert.equal(
    appliedEntryHasRealValue({
      code: "MAKER50",
      type: "percentage",
      value: 50,
      source: "internal",
    }),
    true,
  );
});
