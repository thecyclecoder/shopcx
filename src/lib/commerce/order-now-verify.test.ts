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
  computeConfirmationEndState,
  computeOrderNowVerdict,
  dispatchConfirmationOnVerified,
  dispatchOrderNowRetryOnMigrate,
  dispatchRecoveryOnDecline,
  type ConfirmationDispatchDeps,
  type ConfirmationEndStateEvidence,
  type OrderNowEvidence,
  type OrderNowRetryDeps,
  type OrderNowVerifiedResult,
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

// ── Phase 4: computeConfirmationEndState + dispatchConfirmationOnVerified ─
//
// The Phase 4 verification bullets:
//   - The customer confirmation is sent only after a verified paid order
//     exists.
//   - Sol's confirmation asserts only the verified end state.
//
// The Judy failing-state (0a9e4d7f) motivating this phase: bill_now returned
// success on the trigger ack, then Shopify rejected the charge — the sub
// flipped `last_payment_status='failed'` and `subscription_not_active` /
// dunning ensued, but the customer had already been told her order shipped.
// Written test-first (coaching #8) — pin the failing state we won't confirm.

function baseEndState(
  overrides: Partial<ConfirmationEndStateEvidence> = {},
): ConfirmationEndStateEvidence {
  return {
    paidOrderFound: true,
    paidOrderLineItemsCount: 2,
    paidOrderTotalCents: 4900,
    subscriptionStatus: "active",
    subscriptionLastPaymentStatus: "succeeded",
    ...overrides,
  };
}

test("computeConfirmationEndState: fully healthy paid order + active sub → ok=true, no failed checks", () => {
  const verdict = computeConfirmationEndState(baseEndState());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.failed_checks, []);
});

test("computeConfirmationEndState: Judy failing state (sub not active + last_payment_status='failed') → ok=false, both checks named (test-first, coaching #8)", () => {
  const verdict = computeConfirmationEndState(baseEndState({
    subscriptionStatus: "paused",
    subscriptionLastPaymentStatus: "failed",
  }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.failed_checks.includes("subscription_not_active"), "names sub not active");
    assert.ok(
      verdict.failed_checks.includes("subscription_payment_status_not_succeeded"),
      "names the payment-status drift",
    );
  }
});

test("computeConfirmationEndState: no paid order found → ok=false, 'no_paid_order' named (defensive re-read caught a race)", () => {
  const verdict = computeConfirmationEndState(baseEndState({
    paidOrderFound: false,
    paidOrderLineItemsCount: null,
    paidOrderTotalCents: null,
  }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.failed_checks.includes("no_paid_order"));
  }
});

test("computeConfirmationEndState: paid order with zero line items → ok=false, 'paid_order_empty_line_items' named", () => {
  const verdict = computeConfirmationEndState(baseEndState({
    paidOrderLineItemsCount: 0,
  }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.failed_checks.includes("paid_order_empty_line_items"));
  }
});

test("computeConfirmationEndState: paid order with $0 total → ok=false, 'paid_order_zero_total' named", () => {
  const verdict = computeConfirmationEndState(baseEndState({
    paidOrderTotalCents: 0,
  }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.failed_checks.includes("paid_order_zero_total"));
  }
});

test("computeConfirmationEndState: cancelled sub → ok=false, 'subscription_not_active' named", () => {
  const verdict = computeConfirmationEndState(baseEndState({
    subscriptionStatus: "cancelled",
  }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.failed_checks.includes("subscription_not_active"));
  }
});

test("computeConfirmationEndState: last_payment_status null (unknown state) → ok=false, payment-status check fails (fail-closed — never confirm a state we haven't observed)", () => {
  const verdict = computeConfirmationEndState(baseEndState({
    subscriptionLastPaymentStatus: null,
  }));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(verdict.failed_checks.includes("subscription_payment_status_not_succeeded"));
  }
});

// ── dispatchConfirmationOnVerified ──

function makeConfirmDeps(overrides: {
  verdict?: "ok" | "drifted";
  failed_checks?: string[];
  evidence?: Partial<ConfirmationEndStateEvidence>;
} = {}): { deps: ConfirmationDispatchDeps; calls: Array<{ workspace_id: string; subscription_id: string; fired_at: string }> } {
  const calls: Array<{ workspace_id: string; subscription_id: string; fired_at: string }> = [];
  const evidence = baseEndState(overrides.evidence);
  const verdict = overrides.verdict === "drifted"
    ? { ok: false as const, failed_checks: overrides.failed_checks ?? ["no_paid_order"] }
    : { ok: true as const, failed_checks: [] as [] };
  const deps: ConfirmationDispatchDeps = {
    verifyEndState: async (input) => {
      calls.push(input);
      return { verdict, evidence };
    },
  };
  return { deps, calls };
}

test("dispatchConfirmationOnVerified: ok end state → confirmed=true (Phase 4 verify bullet: send only after verified paid order)", async () => {
  const { deps, calls } = makeConfirmDeps();
  const out = await dispatchConfirmationOnVerified(
    { workspace_id: WORKSPACE, subscription_id: SUB, fired_at: FIRED_AT },
    deps,
  );
  assert.equal(out.confirmed, true);
  if (out.confirmed) {
    assert.equal(out.evidence.subscriptionStatus, "active");
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.subscription_id, SUB);
  assert.equal(calls[0]!.fired_at, FIRED_AT);
});

test("dispatchConfirmationOnVerified: Judy failing state (paused + failed payment) → confirmed=false, failed_checks names both invariants (Phase 4 verify bullet: Sol asserts only the verified end state)", async () => {
  const { deps } = makeConfirmDeps({
    verdict: "drifted",
    failed_checks: ["subscription_not_active", "subscription_payment_status_not_succeeded"],
    evidence: { subscriptionStatus: "paused", subscriptionLastPaymentStatus: "failed" },
  });
  const out = await dispatchConfirmationOnVerified(
    { workspace_id: WORKSPACE, subscription_id: SUB, fired_at: FIRED_AT },
    deps,
  );
  assert.equal(out.confirmed, false);
  if (!out.confirmed) {
    assert.deepEqual(
      out.failed_checks,
      ["subscription_not_active", "subscription_payment_status_not_succeeded"],
    );
    assert.equal(out.evidence.subscriptionStatus, "paused");
  }
});

// ── Phase 3: dispatchOrderNowRetryOnMigrate ───────────────────────
//
// The Phase 3 verification bullets:
//   - Completing the journey migrates the sub to internal and fires an
//     order-now retry with no box session.
//   - The retry is idempotent (a re-drive doesn't create a second order).
//   - The internal retry produces a real paid order.
//
// The dispatcher wraps the guard-then-fire-then-log sequence. In prod the
// deps read customer_events, call subscriptionOrderNowVerified, and log
// commerce.order_now.retry_after_migrate on customer_events. Tests pin the
// guard predicate + one-and-only-one invariant with a fake deps object.

const INTERNAL_CONTRACT = "internal-abc1234def56";
const MIGRATED_AT = "2026-07-08T12:05:00.000Z";

interface RetryFireCall {
  workspace_id: string;
  contract_id: string;
  customer_id?: string;
  ticket_id?: string;
}
interface RetryGuardCall {
  workspace_id: string;
  subscription_id: string;
  migrated_at: string;
}
interface RetryLogCall {
  workspace_id: string;
  customer_id: string;
  subscription_id: string;
  contract_id: string;
  migrated_at: string;
}

function makeRetryDeps(overrides: {
  alreadyRetried?: boolean;
  fireResult?: Partial<OrderNowVerifiedResult>;
} = {}): { deps: OrderNowRetryDeps; fireCalls: RetryFireCall[]; guardCalls: RetryGuardCall[]; logCalls: RetryLogCall[] } {
  const fireCalls: RetryFireCall[] = [];
  const guardCalls: RetryGuardCall[] = [];
  const logCalls: RetryLogCall[] = [];
  const deps: OrderNowRetryDeps = {
    alreadyRetriedSinceMigrated: async (input) => {
      guardCalls.push(input);
      return overrides.alreadyRetried ?? false;
    },
    fireVerifiedOrderNow: async (workspace_id, contract_id, ctx) => {
      fireCalls.push({ workspace_id, contract_id, customer_id: ctx.customer_id, ticket_id: ctx.ticket_id });
      return {
        success: true,
        summary: "Triggered internal renewal (order now)",
        internal: true,
        pending: false,
        fired_at: MIGRATED_AT,
        subscription_id: SUB,
        ...overrides.fireResult,
      };
    },
    logRetryEvent: async (input) => {
      logCalls.push(input);
    },
  };
  return { deps, fireCalls, guardCalls, logCalls };
}

test("dispatchOrderNowRetryOnMigrate: fresh migrate → guard consulted, fireVerifiedOrderNow called ONCE with internal contract, logRetryEvent recorded (Phase 3 verify: journey completes → migrate → retry, no box session)", async () => {
  const { deps, fireCalls, guardCalls, logCalls } = makeRetryDeps();
  const out = await dispatchOrderNowRetryOnMigrate(
    {
      workspace_id: WORKSPACE,
      customer_id: CUSTOMER,
      subscription_id: SUB,
      contract_id: INTERNAL_CONTRACT,
      migrated_at: MIGRATED_AT,
    },
    deps,
  );
  assert.equal(guardCalls.length, 1, "guard consulted before firing");
  assert.equal(guardCalls[0]!.subscription_id, SUB);
  assert.equal(guardCalls[0]!.migrated_at, MIGRATED_AT);
  assert.equal(fireCalls.length, 1, "fireVerifiedOrderNow called exactly once");
  assert.equal(fireCalls[0]!.contract_id, INTERNAL_CONTRACT, "retry targets the POST-migration internal contract id");
  assert.equal(fireCalls[0]!.workspace_id, WORKSPACE);
  assert.equal(fireCalls[0]!.customer_id, CUSTOMER);
  assert.equal(logCalls.length, 1, "retry event logged as idempotency marker");
  assert.equal(logCalls[0]!.subscription_id, SUB);
  assert.equal(out.retried, true);
  if (out.retried) {
    assert.equal(out.contract_id, INTERNAL_CONTRACT);
    assert.equal(out.internal, true, "internal sub — deterministic Braintree renewal, no Appstle delay");
    assert.equal(out.fired_at, MIGRATED_AT);
  }
});

test("dispatchOrderNowRetryOnMigrate: prior retry event since migrated_at → soft-skip, fire NOT called (Phase 3 verify: retry is idempotent, a re-drive doesn't create a second order)", async () => {
  const { deps, fireCalls, logCalls, guardCalls } = makeRetryDeps({ alreadyRetried: true });
  const out = await dispatchOrderNowRetryOnMigrate(
    {
      workspace_id: WORKSPACE,
      customer_id: CUSTOMER,
      subscription_id: SUB,
      contract_id: INTERNAL_CONTRACT,
      migrated_at: MIGRATED_AT,
    },
    deps,
  );
  assert.equal(fireCalls.length, 0, "fireVerifiedOrderNow NOT called when guard says already retried");
  assert.equal(logCalls.length, 0, "no re-log — the prior event still trips the next guard");
  assert.equal(guardCalls.length, 1);
  assert.equal(out.retried, false);
  if (!out.retried) {
    assert.equal(out.skipped_reason, "already_retried_since_migrated");
    assert.equal(out.contract_id, INTERNAL_CONTRACT);
  }
});

test("dispatchOrderNowRetryOnMigrate: fireVerifiedOrderNow reports success=false → returned skipped_reason='fire_failed' + error surfaced, log NOT recorded (Phase 3 verify: failed fire doesn't trip the idempotency marker → a later retry can still succeed)", async () => {
  const { deps, logCalls } = makeRetryDeps({
    fireResult: { success: false, error: "subscription_not_found" },
  });
  const out = await dispatchOrderNowRetryOnMigrate(
    {
      workspace_id: WORKSPACE,
      customer_id: CUSTOMER,
      subscription_id: SUB,
      contract_id: INTERNAL_CONTRACT,
      migrated_at: MIGRATED_AT,
    },
    deps,
  );
  assert.equal(logCalls.length, 0, "no marker logged — a later retry can succeed");
  assert.equal(out.retried, false);
  if (!out.retried) {
    assert.equal(out.skipped_reason, "fire_failed");
    assert.equal(out.error, "subscription_not_found");
  }
});

test("dispatchOrderNowRetryOnMigrate: successful internal retry returns internal=true + a real paid-order-producing fire (Phase 3 verify: the internal retry produces a real paid order)", async () => {
  // The dispatcher fires subscriptionOrderNowVerified on the migrated
  // internal sub — which, per subscriptionOrderNow → orderNowByContract
  // (appstle.ts), triggers the `internal-subscription/renewal-attempt`
  // Inngest event. That pipeline charges Braintree and creates a paid
  // order. Here we pin the dispatcher's contract with the fire deps: on
  // success we return internal=true (the payment path that produces a
  // real paid order — no Appstle latency) with a fired_at cursor the
  // async verify (Phase 1) can read against.
  const { deps } = makeRetryDeps({
    fireResult: {
      success: true,
      internal: true,
      pending: false,
      fired_at: MIGRATED_AT,
      subscription_id: SUB,
      summary: "Triggered internal renewal (order now)",
    },
  });
  const out = await dispatchOrderNowRetryOnMigrate(
    {
      workspace_id: WORKSPACE,
      customer_id: CUSTOMER,
      subscription_id: SUB,
      contract_id: INTERNAL_CONTRACT,
      migrated_at: MIGRATED_AT,
    },
    deps,
  );
  assert.equal(out.retried, true);
  if (out.retried) {
    // internal=true is the invariant that says "this fired the Braintree
    // renewal pipeline (which produces a paid order), not an Appstle
    // bill_now (which is delayed + can decline)".
    assert.equal(out.internal, true);
    assert.equal(out.result.success, true);
    assert.equal(out.result.internal, true);
    // pending=false: internal-sub verify is deterministic; the async verify
    // still runs but only to ground-truth the ledger stamp.
    assert.equal(out.result.pending, false);
    assert.equal(out.fired_at, MIGRATED_AT);
  }
});
