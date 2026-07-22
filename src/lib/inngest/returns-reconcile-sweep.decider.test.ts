/**
 * Unit tests for the Phase-3 sweep deciders — the pure functions that
 * turn (return row, live ledger, tracker status) into one of the sweep
 * actions the cron executes.
 *
 * Pins the invariant that keeps the sweep safe under CLAUDE.md's
 * "guard before mutation" rule:
 *   - The `easypost_shipment_id IS NOT NULL` scope + workspace-scoped
 *     compare-and-set writes on `refunded_at IS NULL` mean we can never
 *     re-refund an imported/Shopify-native return we don't own.
 *   - `redrive_refund` is the SAFE default whenever the ledger is
 *     readable enough to know the money hasn't moved out of band —
 *     `refundOrder`'s pre-dispatch `order_refunds.request_key` guard
 *     makes re-driving money-moves-once idempotent.
 *   - `escalate_no_order` fires ONLY when the row genuinely has no
 *     order link (order_id null AND shopify_order_gid repair failed).
 *     Otherwise the sweep would spam the operator on every recoverable
 *     row.
 *
 * Also pins the upstream decider's threshold model — mirror of the
 * 30-day carrier-lost escalation in scripts/returns-spot-check.ts.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/returns-reconcile-sweep.decider.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideDeliveredSweep,
  decideUpstreamSweep,
  isEasyPostRateLimitError,
} from "./returns-reconcile-sweep";
import type { OrderRefundLedger } from "@/lib/refund-ledger";

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

// ── decideDeliveredSweep ──────────────────────────────────────────

test("decideDeliveredSweep: no order_id → escalate_no_order (SC131156 with unresolvable gid)", () => {
  const action = decideDeliveredSweep({
    hasOrderId: false,
    netRefundCents: 13362,
    ledger: { ok: false, reason: "order_not_found" },
  });
  assert.equal(action.kind, "escalate_no_order");
});

test("decideDeliveredSweep: order_id + ledger shows OOB-refunded → stamp_oob (SC130193)", () => {
  const action = decideDeliveredSweep({
    hasOrderId: true,
    netRefundCents: 13362,
    ledger: okLedger({ saleCents: 13362, refundedCents: 13362, refundableCents: 0, outOfBandCents: 13362 }),
  });
  assert.equal(action.kind, "stamp_oob");
  if (action.kind === "stamp_oob") {
    assert.equal(action.refundedCents, 13362);
  }
});

test("decideDeliveredSweep: order_id + ledger says cap → redrive_refund (Phase 1 does the cap inside the handler)", () => {
  const action = decideDeliveredSweep({
    hasOrderId: true,
    netRefundCents: 13362,
    ledger: okLedger({ saleCents: 20000, refundedCents: 12000, refundableCents: 8000 }),
  });
  assert.equal(action.kind, "redrive_refund");
  if (action.kind === "redrive_refund") {
    assert.match(action.reason, /cap_to_ledger/);
  }
});

test("decideDeliveredSweep: order_id + ledger says full refund available → redrive_refund", () => {
  const action = decideDeliveredSweep({
    hasOrderId: true,
    netRefundCents: 13362,
    ledger: okLedger({ saleCents: 13362, refundedCents: 0, refundableCents: 13362 }),
  });
  assert.equal(action.kind, "redrive_refund");
});

test("decideDeliveredSweep: ledger unreadable but order_id present → redrive_refund (Phase 2 onFailure will escalate if it stays broken)", () => {
  // We DON'T want to escalate synchronously here — the sweep would spam
  // the operator on every intermittent Shopify hiccup. Let the refund
  // handler try; its `retries: 2` + onFailure carries the exhaustion.
  const action = decideDeliveredSweep({
    hasOrderId: true,
    netRefundCents: 13362,
    ledger: { ok: false, reason: "shopify_call_failed", error: "500" },
  });
  assert.equal(action.kind, "redrive_refund");
});

test("decideDeliveredSweep: order_id + ledger says refundable=0 AND refunded < contract → redrive_refund (Phase 2 catches the underlying failure)", () => {
  const action = decideDeliveredSweep({
    hasOrderId: true,
    netRefundCents: 13362,
    ledger: okLedger({ saleCents: 0, refundedCents: 0, refundableCents: 0 }),
  });
  assert.equal(action.kind, "redrive_refund");
});

// ── decideUpstreamSweep ───────────────────────────────────────────

test("decideUpstreamSweep: EasyPost says delivered → promote_delivered (webhook-missed case)", () => {
  const action = decideUpstreamSweep({ trackerStatus: "delivered", ageDays: 20 });
  assert.equal(action.kind, "promote_delivered");
});

test("decideUpstreamSweep: EasyPost says available_for_pickup → promote_delivered", () => {
  const action = decideUpstreamSweep({ trackerStatus: "available_for_pickup", ageDays: 20 });
  assert.equal(action.kind, "promote_delivered");
});

test("decideUpstreamSweep: EasyPost says failure → escalate_failure", () => {
  const action = decideUpstreamSweep({ trackerStatus: "failure", ageDays: 20 });
  assert.equal(action.kind, "escalate_failure");
  if (action.kind === "escalate_failure") {
    assert.equal(action.trackerStatus, "failure");
  }
});

test("decideUpstreamSweep: EasyPost says return_to_sender → escalate_failure", () => {
  const action = decideUpstreamSweep({ trackerStatus: "return_to_sender", ageDays: 20 });
  assert.equal(action.kind, "escalate_failure");
});

test("decideUpstreamSweep: still in_transit at 15d → no_action (under the 30d escalation threshold)", () => {
  const action = decideUpstreamSweep({ trackerStatus: "in_transit", ageDays: 15 });
  assert.equal(action.kind, "no_action");
});

test("decideUpstreamSweep: still in_transit at exactly 30d → escalate_stale (carrier-lost)", () => {
  const action = decideUpstreamSweep({ trackerStatus: "in_transit", ageDays: 30 });
  assert.equal(action.kind, "escalate_stale");
});

test("decideUpstreamSweep: still in_transit at 45d → escalate_stale", () => {
  const action = decideUpstreamSweep({ trackerStatus: "in_transit", ageDays: 45 });
  assert.equal(action.kind, "escalate_stale");
});

test("decideUpstreamSweep: null trackerStatus at 45d → escalate_stale", () => {
  const action = decideUpstreamSweep({ trackerStatus: null, ageDays: 45 });
  assert.equal(action.kind, "escalate_stale");
});

// ── isEasyPostRateLimitError ─────────────────────────────────────

test("isEasyPostRateLimitError: EasyPost rate-limit error message → true (log at warn, sweep skips + retries next daily run)", () => {
  const err = new Error(
    "Your account has been temporarily rate-limited due to excessive resource consumption",
  );
  assert.equal(isEasyPostRateLimitError(err), true);
});

test("isEasyPostRateLimitError: arbitrary EasyPost 500 → false (keep at error, real outage still pages)", () => {
  const err = new Error("EasyPost 500 Internal Server Error");
  assert.equal(isEasyPostRateLimitError(err), false);
});
