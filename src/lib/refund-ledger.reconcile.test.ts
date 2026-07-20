/**
 * Unit tests for decideRefundReconcile — the pure branch decider that
 * lets returnsIssueRefund reconcile against the live gateway ledger
 * before dispatching a refund.
 *
 * Pins each of the four cases the Phase 1 spec enumerates in
 * .box/spec-self-healing-return-refund-rail.md (which fold into
 * docs/brain/lifecycles/return-pipeline.md § Phase 4 step 2b):
 *
 *   - refundableCents === 0 AND refundedCents >= net_refund_cents
 *     → stamp_out_of_band (SC130193 — money already moved out of band)
 *   - 0 < refundableCents < net_refund_cents
 *     → cap_to_ledger with the exact shortfall (SC133086 / SC129432)
 *   - refundableCents >= net_refund_cents
 *     → refund_full_contract (unchanged path)
 *   - ledger.ok === false (Shopify call failed / no order)
 *     → refund_full_contract fallthrough (Phase 1 does not add new
 *       failure modes; Phase 2 will make the underlying failure loud)
 *
 * Also pins the contract-vs-ceiling invariant: the decider NEVER
 * raises the payout above netRefundCents; on the cap branch it lowers
 * it to the ledger ceiling, on the OOB branch it dispatches nothing.
 *
 * Run:
 *   npx tsx --test src/lib/refund-ledger.reconcile.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideRefundReconcile, type OrderRefundLedger } from "./refund-ledger";

function okLedger(overrides: Partial<Extract<OrderRefundLedger, { ok: true }>> = {}): OrderRefundLedger {
  return {
    ok: true,
    saleCents: 0,
    refundedCents: 0,
    pendingCents: 0,
    refundableCents: 0,
    outOfBandCents: 0,
    refunds: [],
    ...overrides,
  };
}

// ── Branch: stamp_out_of_band ───────────────────────────────────

test("decideRefundReconcile: refundable=0 AND refunded>=contract → stamp_out_of_band (SC130193)", () => {
  // Full sale ($133.62) already fully refunded out-of-band in Shopify.
  const ledger = okLedger({
    saleCents: 13362,
    refundedCents: 13362,
    refundableCents: 0,
    outOfBandCents: 13362,
  });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "stamp_out_of_band");
  if (decision.branch === "stamp_out_of_band") {
    assert.equal(decision.refundedCents, 13362);
  }
});

test("decideRefundReconcile: refundable=0 AND refunded > contract → stamp_out_of_band (overshoot still stamps)", () => {
  // Real case: someone refunded a larger amount out-of-band than the
  // return's contract. The ledger still says nothing is refundable and
  // the customer is more than made whole — stamp, don't try to refund.
  const ledger = okLedger({ saleCents: 15000, refundedCents: 15000, refundableCents: 0, outOfBandCents: 15000 });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "stamp_out_of_band");
});

// ── Branch: cap_to_ledger ────────────────────────────────────────

test("decideRefundReconcile: 0 < refundable < contract → cap_to_ledger with exact shortfall (SC133086)", () => {
  // Two small refunds landed a month earlier; the gateway now caps at
  // less than what the return's stored contract wants to pay.
  const ledger = okLedger({
    saleCents: 20000,
    refundedCents: 12000,
    refundableCents: 8000,
  });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "cap_to_ledger");
  if (decision.branch === "cap_to_ledger") {
    assert.equal(decision.refundCents, 8000);
    assert.equal(decision.shortfallCents, 13362 - 8000);
  }
});

test("decideRefundReconcile: refundable one cent under contract → cap by one cent", () => {
  const ledger = okLedger({ saleCents: 13362, refundedCents: 1, refundableCents: 13361 });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "cap_to_ledger");
  if (decision.branch === "cap_to_ledger") {
    assert.equal(decision.refundCents, 13361);
    assert.equal(decision.shortfallCents, 1);
  }
});

// ── Branch: refund_full_contract ─────────────────────────────────

test("decideRefundReconcile: refundable === contract → refund_full_contract (no cap)", () => {
  const ledger = okLedger({ saleCents: 13362, refundedCents: 0, refundableCents: 13362 });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "refund_full_contract");
  if (decision.branch === "refund_full_contract") {
    assert.equal(decision.refundCents, 13362);
  }
});

test("decideRefundReconcile: refundable > contract → refund_full_contract (never raises payout)", () => {
  // Gateway has more headroom than the contract wants — the CONTRACT
  // is the intent, the ledger is only the CEILING. The rail must not
  // raise the payout above what return-creation stored.
  const ledger = okLedger({ saleCents: 20000, refundedCents: 0, refundableCents: 20000 });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "refund_full_contract");
  if (decision.branch === "refund_full_contract") {
    assert.equal(decision.refundCents, 13362, "must not raise payout above the stored contract");
  }
});

// ── Fallthrough: ledger.ok === false ─────────────────────────────

test("decideRefundReconcile: ledger.ok=false (order_not_found) → refund_full_contract fallthrough", () => {
  const decision = decideRefundReconcile({ ok: false, reason: "order_not_found" }, 13362);
  assert.equal(decision.branch, "refund_full_contract");
  if (decision.branch === "refund_full_contract") {
    assert.equal(decision.refundCents, 13362);
  }
});

test("decideRefundReconcile: ledger.ok=false (shopify_call_failed) → refund_full_contract fallthrough", () => {
  const decision = decideRefundReconcile({ ok: false, reason: "shopify_call_failed", error: "500" }, 13362);
  assert.equal(decision.branch, "refund_full_contract");
});

// ── Edge: refundable=0 AND refunded < contract ───────────────────

test("decideRefundReconcile: refundable=0 AND refunded < contract → refund_full_contract (Phase 2 will make it loud)", () => {
  // Nothing left to refund AND nothing was refunded out of band that
  // covers the contract — Phase 1's OOB branch is intentionally scoped
  // (`refunded >= contract`) so we don't silently stamp a return that
  // was never actually paid. This case falls through to today's
  // behaviour; refundOrder will fail at the gateway, and Phase 2 will
  // make that failure escalate.
  const ledger = okLedger({ saleCents: 0, refundedCents: 0, refundableCents: 0 });
  const decision = decideRefundReconcile(ledger, 13362);
  assert.equal(decision.branch, "refund_full_contract");
});
