/**
 * Regression test for [[../../docs/brain/specs/return-net-refund-must-net-order-level-coupon-discounts]]
 * Phase 1 — `clampNetRefundToLiveCeiling` caps a computed `net_refund_cents` at the live refundable
 * ceiling from `getOrderRefundLedger`. The NAMED FAILING STATE from derived-from ticket `cc78ad94`
 * (Anne Bergeron SC138816): Strawberry Lemonade $59.96 × 2 = $119.92 gross with a $15-off
 * ORDER-LEVEL loyalty coupon (in `orders.discount_codes`, NOT allocated per line — so
 * `line_items[].total_discount_cents` is 0 and `deriveOrderSubtotalCentsFromLines` sums $119.92).
 * The customer actually paid $104.92 subtotal + $10.72 tax = $115.64 (the live refundable ceiling
 * from Shopify). Before this fix `assertReturnRefundHeadroom` refused the crisis white-glove return
 * outright ("net_refund $119.92 exceeds live refundable ceiling $115.64"). The clamp caps
 * `net_refund_cents` at $115.64 so the return is created — a return promising up to the live
 * ceiling never strands the customer.
 *
 * Pure — only exercises the clamp helper.
 *
 * Run:
 *   npm run test:shopify-returns-clamp-net-refund
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampNetRefundToLiveCeiling } from "./shopify-returns";

test("Anne SC138816 shape: net $119.92 > live ceiling $115.64 (order-level coupon) ⇒ clamps to $115.64", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 11992,
    refundableCents: 11564,
  });
  assert.equal(verdict.netRefundCents, 11564, "the clamp must cap the promise at the live ceiling");
  assert.equal(verdict.clamped, true, "clamped flag must be true so the caller can log the correction");
});

test("net at ceiling ⇒ no clamp (returns net unchanged)", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 10000,
    refundableCents: 10000,
  });
  assert.equal(verdict.netRefundCents, 10000);
  assert.equal(verdict.clamped, false);
});

test("net below ceiling ⇒ no clamp (returns net unchanged)", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 5000,
    refundableCents: 10000,
  });
  assert.equal(verdict.netRefundCents, 5000);
  assert.equal(verdict.clamped, false);
});

test("net = 0 ⇒ no clamp regardless of ceiling", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 0,
    refundableCents: 10000,
  });
  assert.equal(verdict.netRefundCents, 0);
  assert.equal(verdict.clamped, false);
});

test("refundableCents = null (Shopify unreadable) ⇒ leaves net untouched, clamped=false", () => {
  // The clamp cannot invent a ceiling from a missing signal. The upstream
  // `assertReturnRefundHeadroom` still refuses on this branch — the clamp is not the gate here.
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 11992,
    refundableCents: null,
  });
  assert.equal(verdict.netRefundCents, 11992, "unreadable ledger must not clamp — the guard refuses upstream");
  assert.equal(verdict.clamped, false);
});

test("refundableCents = 0 (fully refunded) ⇒ clamps net down to 0", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 5000,
    refundableCents: 0,
  });
  assert.equal(verdict.netRefundCents, 0);
  assert.equal(verdict.clamped, true);
});

test("negative net input floors at 0 first, then compares to ceiling ⇒ no clamp", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: -500,
    refundableCents: 1000,
  });
  assert.equal(verdict.netRefundCents, 0);
  assert.equal(verdict.clamped, false);
});

test("non-finite net (NaN) is treated as 0 ⇒ no clamp against a valid ceiling", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: Number.NaN,
    refundableCents: 5000,
  });
  assert.equal(verdict.netRefundCents, 0);
  assert.equal(verdict.clamped, false);
});

test("negative refundableCents floors at 0 ⇒ clamps any positive net down to 0", () => {
  const verdict = clampNetRefundToLiveCeiling({
    netRefundCents: 1000,
    refundableCents: -100,
  });
  assert.equal(verdict.netRefundCents, 0);
  assert.equal(verdict.clamped, true);
});
