/**
 * Unit tests for `computeOrderNowVerdict` — the pure predicate that maps
 * evidence (billing-failure / billing-success events, last_payment_status,
 * new paid orders since fired_at) to the ledger verdict.
 *
 * Pins the Phase 1 decision table so a later refactor can't silently flip
 * an Appstle billing-failure back to 'confirmed' (the ticket 0a9e4d7f — Judy
 * — failure mode the spec exists to fix).
 *
 * Run:
 *   npx tsx --test src/lib/commerce/order-now-verify.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeOrderNowVerdict,
  type OrderNowEvidence,
} from "./order-now-verify";

function baseEvidence(overrides: Partial<OrderNowEvidence> = {}): OrderNowEvidence {
  return {
    hasBillingFailureEvent: false,
    hasBillingSuccessEvent: false,
    lastPaymentStatus: null,
    hasNewPaidOrder: false,
    ...overrides,
  };
}

test("computeOrderNowVerdict: no evidence → 'unknown' (async verify re-schedules)", () => {
  assert.equal(computeOrderNowVerdict(baseEvidence()), "unknown");
});

test("computeOrderNowVerdict: a new paid order since fired_at → 'paid'", () => {
  assert.equal(
    computeOrderNowVerdict(baseEvidence({ hasNewPaidOrder: true })),
    "paid",
  );
});

test("computeOrderNowVerdict: a subscription.billing-success event → 'paid'", () => {
  assert.equal(
    computeOrderNowVerdict(baseEvidence({ hasBillingSuccessEvent: true })),
    "paid",
  );
});

test("computeOrderNowVerdict: last_payment_status='succeeded' alone → 'paid'", () => {
  assert.equal(
    computeOrderNowVerdict(baseEvidence({ lastPaymentStatus: "succeeded" })),
    "paid",
  );
});

test("computeOrderNowVerdict: a subscription.billing-failure event → 'declined' (spec: Judy — bill_now declined after a success ack)", () => {
  assert.equal(
    computeOrderNowVerdict(baseEvidence({ hasBillingFailureEvent: true })),
    "declined",
  );
});

test("computeOrderNowVerdict: last_payment_status='failed' alone → 'declined'", () => {
  assert.equal(
    computeOrderNowVerdict(baseEvidence({ lastPaymentStatus: "failed" })),
    "declined",
  );
});

test("computeOrderNowVerdict: paid signal wins over declined signal (card rotation between fire + verify)", () => {
  // A billing-failure event landed but then a card rotation succeeded and
  // wrote a paid order + billing-success. Customer's account state ends
  // up ok — resolve to 'paid' so the ticket ledger reflects reality.
  assert.equal(
    computeOrderNowVerdict(baseEvidence({
      hasBillingFailureEvent: true,
      hasNewPaidOrder: true,
    })),
    "paid",
  );
  assert.equal(
    computeOrderNowVerdict(baseEvidence({
      hasBillingFailureEvent: true,
      hasBillingSuccessEvent: true,
    })),
    "paid",
  );
});

test("computeOrderNowVerdict: last_payment_status='skipped' does NOT force a verdict (neither paid nor declined) — returns 'unknown'", () => {
  // 'skipped' is a benign upstream state (dunning skip / SKIPPED_DUNNING_MGMT).
  // The verify must not treat it as either a confirmed paid order or a hard
  // decline — the async verify re-schedules and reads again.
  assert.equal(
    computeOrderNowVerdict(baseEvidence({ lastPaymentStatus: "skipped" })),
    "unknown",
  );
});
