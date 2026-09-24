/**
 * Tests for `decideRefundStatusFromLedger` — the pure predicate the
 * refund chokepoint's ONE writer (`deriveAndSetOrderRefundStatus`) and
 * the reconcile backfill both consult.
 *
 * Phase 1 of docs/brain/specs/a-braintree-side-refund-must-reach-our-books.md.
 *
 * Pins the SHOPCX373 named failing state (ledger sums to exactly the
 * order total but the order still reads `paid` — must be advanced to
 * `refunded`) and the idempotency proof the spec requires (a row
 * already at the correct terminal state returns null and is a no-op
 * on a second run).
 *
 * Run:
 *   npx tsx --test src/lib/refund.derive-status.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideRefundStatusFromLedger } from "./refund";

test("SHOPCX373: ledger sum equals total_cents + status='paid' ⇒ 'refunded'", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 14028,
      totalCents: 14028,
      currentStatus: "paid",
    }),
    "refunded",
  );
});

test("idempotency: a row already at 'refunded' returns null (no-op on a second run)", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 14028,
      totalCents: 14028,
      currentStatus: "refunded",
    }),
    null,
  );
});

test("partial ledger sum ⇒ 'partially_refunded'", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 5000,
      totalCents: 14028,
      currentStatus: "paid",
    }),
    "partially_refunded",
  );
});

test("case-insensitive current: stored 'PAID' still advances to 'refunded'", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 14028,
      totalCents: 14028,
      currentStatus: "PAID",
    }),
    "refunded",
  );
});

test("case-insensitive current: stored 'REFUNDED' still short-circuits (no regression)", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 5000,
      totalCents: 14028,
      currentStatus: "REFUNDED",
    }),
    null,
  );
});

test("never regress a stronger stored state: 'refunded' + partial ledger ⇒ null", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 5000,
      totalCents: 14028,
      currentStatus: "refunded",
    }),
    null,
  );
});

test("does not churn same weight: stored 'partially_refunded' + partial ledger ⇒ null", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 5000,
      totalCents: 14028,
      currentStatus: "partially_refunded",
    }),
    null,
  );
});

test("upgrades 'partially_refunded' to 'refunded' when ledger clears the total", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 14028,
      totalCents: 14028,
      currentStatus: "partially_refunded",
    }),
    "refunded",
  );
});

test("zero ledger sum ⇒ null regardless of stored status", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 0,
      totalCents: 14028,
      currentStatus: "paid",
    }),
    null,
  );
});

test("positive ledger with zero total ⇒ 'refunded' (defensive)", () => {
  assert.equal(
    decideRefundStatusFromLedger({
      refundedCents: 100,
      totalCents: 0,
      currentStatus: "paid",
    }),
    "refunded",
  );
});
