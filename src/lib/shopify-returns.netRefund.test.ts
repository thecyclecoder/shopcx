/**
 * Regression test for [[../../docs/brain/specs/a-money-remedy-must-read-the-live-remedy-state-first]]
 * Phase 2 — a return nets out refunds already issued.
 *
 * The NAMED FAILING STATE from derived-from ticket `86043da0` (Jan Bloom): SC135494 order total
 * $182.95, a $15 refund already fired at 19:56, then a return created at 20:32. Before Phase 2
 * shipped, the return's `net_refund_cents` snapshot was the FULL $182.95 (18295 cents) — one
 * EasyPost delivery away from over-refunding by $15 silently. The fix subtracts already-succeeded
 * `order_refunds` from the ceiling, so the stored contract is $167.95 (16795 cents) — the amount
 * actually still owed on the order.
 *
 * Pure — only exercises the compute function; the async `sumSucceededOrderRefundsCents` ledger
 * reader is a thin Supabase wrapper covered by integration in the executor's own test.
 *
 * Run:
 *   npm run test:shopify-returns-net-refund
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeReturnNetRefundCents } from "./shopify-returns";

test("computeReturnNetRefundCents — Jan Bloom shape: $182.95 order, $15 already refunded, $0 label ⇒ $167.95 (NOT $182.95)", () => {
  const netRefundCents = computeReturnNetRefundCents({
    orderTotalCents: 18295,
    labelCostCents: 0,
    refundsSucceededCents: 1500,
  });
  assert.equal(
    netRefundCents,
    16795,
    "the return contract must NOT re-refund the $15 already succeeded",
  );
  assert.notEqual(
    netRefundCents,
    18295,
    "the pre-Phase-2 buggy value that would have over-refunded by $15",
  );
});

test("computeReturnNetRefundCents — clean state (no prior refunds): $182.95 - $0 refunds - $8.50 label = $174.45", () => {
  const netRefundCents = computeReturnNetRefundCents({
    orderTotalCents: 18295,
    labelCostCents: 850,
    refundsSucceededCents: 0,
  });
  assert.equal(netRefundCents, 17445);
});

test("computeReturnNetRefundCents — free label + no prior refunds is a full-order refund: $182.95 - $0 - $0 = $182.95", () => {
  const netRefundCents = computeReturnNetRefundCents({
    orderTotalCents: 18295,
    labelCostCents: 0,
    refundsSucceededCents: 0,
  });
  assert.equal(netRefundCents, 18295);
});

test("computeReturnNetRefundCents — refunds already at/above total ⇒ floors at 0 (no negative refund; no `store_credit` payout for a zero balance)", () => {
  const netRefundCents = computeReturnNetRefundCents({
    orderTotalCents: 10000,
    labelCostCents: 500,
    refundsSucceededCents: 15000,
  });
  assert.equal(netRefundCents, 0);
});

test("computeReturnNetRefundCents — a prior refund plus a label cost both subtract: $200 - $50 refunded - $10 label = $140", () => {
  const netRefundCents = computeReturnNetRefundCents({
    orderTotalCents: 20000,
    labelCostCents: 1000,
    refundsSucceededCents: 5000,
  });
  assert.equal(netRefundCents, 14000);
});

test("computeReturnNetRefundCents — non-finite inputs are treated as 0 (defensive against NaN from a null column) — never a NaN payout", () => {
  const netRefundCents = computeReturnNetRefundCents({
    orderTotalCents: Number.NaN,
    labelCostCents: 500,
    refundsSucceededCents: 1500,
  });
  assert.equal(netRefundCents, 0);
});
