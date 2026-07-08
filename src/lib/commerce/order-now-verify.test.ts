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
  dispatchRecoveryOnDecline,
  type OrderNowEvidence,
  type RecoveryDispatchDeps,
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

// ── Phase 2: dispatchRecoveryOnDecline ────────────────────────────
//
// The Phase 2 verification bullets:
//   - A declined order-now triggers EXACTLY ONE update-payment-method
//     journey delivery to the customer.
//   - No success/confirmation message is sent on a decline (the dispatcher
//     ONLY sends the recovery journey — never a "your order shipped"
//     confirmation).
//
// The dispatcher is the fire-recovery-once helper; the Inngest fn is a thin
// adapter around it. These tests pin the guard predicate + one-and-only-one
// invariant with a fake deps object.

const WORKSPACE = "10000000-0000-0000-0000-000000000001";
const CUSTOMER = "20000000-0000-0000-0000-000000000001";
const SUB = "30000000-0000-0000-0000-000000000001";
const FIRED_AT = "2026-07-08T12:00:00.000Z";

interface SendCall {
  workspace_id: string;
  customer_id: string;
  subscriptionId?: string;
}
interface CountCall {
  workspace_id: string;
  customer_id: string;
  fired_at: string;
}

function makeDeps(overrides: {
  alreadySent?: boolean;
  sendResult?: { sent: boolean; ticketId?: string; error?: string };
} = {}): { deps: RecoveryDispatchDeps; sendCalls: SendCall[]; countCalls: CountCall[] } {
  const sendCalls: SendCall[] = [];
  const countCalls: CountCall[] = [];
  const deps: RecoveryDispatchDeps = {
    alreadySentSinceFiredAt: async (input) => {
      countCalls.push(input);
      return overrides.alreadySent ?? false;
    },
    sendRecovery: async (workspace_id, customer_id, opts) => {
      sendCalls.push({ workspace_id, customer_id, subscriptionId: opts?.subscriptionId });
      return overrides.sendResult ?? { sent: true, ticketId: "ticket-recovery-1", messageId: "msg-1" };
    },
  };
  return { deps, sendCalls, countCalls };
}

test("dispatchRecoveryOnDecline: fresh decline → sendRecovery called ONCE, sent=true (Phase 2 verify bullet: exactly one journey delivery)", async () => {
  const { deps, sendCalls, countCalls } = makeDeps();
  const out = await dispatchRecoveryOnDecline(
    { workspace_id: WORKSPACE, subscription_id: SUB, customer_id: CUSTOMER, fired_at: FIRED_AT },
    deps,
  );
  assert.equal(sendCalls.length, 1, "sendRecovery called exactly once");
  assert.equal(sendCalls[0]!.workspace_id, WORKSPACE);
  assert.equal(sendCalls[0]!.customer_id, CUSTOMER);
  assert.equal(sendCalls[0]!.subscriptionId, SUB, "subscription id threads through so the email renders the right sub details");
  assert.equal(countCalls.length, 1, "guard predicate was consulted before firing");
  assert.equal(countCalls[0]!.fired_at, FIRED_AT);
  assert.deepEqual(out, { sent: true, ticket_id: "ticket-recovery-1", message_id: "msg-1" });
});

test("dispatchRecoveryOnDecline: prior dunning.recovery_email_sent since fired_at → soft-skip (no second delivery, Phase 2 exactly-one guard)", async () => {
  const { deps, sendCalls, countCalls } = makeDeps({ alreadySent: true });
  const out = await dispatchRecoveryOnDecline(
    { workspace_id: WORKSPACE, subscription_id: SUB, customer_id: CUSTOMER, fired_at: FIRED_AT },
    deps,
  );
  assert.equal(sendCalls.length, 0, "sendRecovery NOT called when guard says already sent");
  assert.equal(countCalls.length, 1);
  assert.equal(out.sent, false);
  if (!out.sent) assert.equal(out.skipped_reason, "already_sent_since_fired_at");
});

test("dispatchRecoveryOnDecline: missing customer_id → soft-skip, guard NOT consulted (no target to email)", async () => {
  const { deps, sendCalls, countCalls } = makeDeps();
  const out = await dispatchRecoveryOnDecline(
    { workspace_id: WORKSPACE, subscription_id: SUB, customer_id: null, fired_at: FIRED_AT },
    deps,
  );
  assert.equal(sendCalls.length, 0);
  assert.equal(countCalls.length, 0, "guard predicate skipped when there's no customer to send to");
  assert.equal(out.sent, false);
  if (!out.sent) assert.equal(out.skipped_reason, "no_customer_id");
});

test("dispatchRecoveryOnDecline: sendRecovery reports sent=false → returned skipped_reason='send_failed' with error surfaced", async () => {
  const { deps } = makeDeps({ sendResult: { sent: false, error: "resend_not_configured" } });
  const out = await dispatchRecoveryOnDecline(
    { workspace_id: WORKSPACE, subscription_id: SUB, customer_id: CUSTOMER, fired_at: FIRED_AT },
    deps,
  );
  assert.equal(out.sent, false);
  if (!out.sent) {
    assert.equal(out.skipped_reason, "send_failed");
    assert.equal(out.error, "resend_not_configured");
  }
});
