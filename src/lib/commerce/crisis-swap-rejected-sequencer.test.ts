/**
 * Phase 3 verification for
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * Pins the three Phase 3 § Verification predicates:
 *
 *   1. The full refund NEVER exceeds `order_total − prior refunds` — the Cheri
 *      case: $116.41 total, $26.89 already refunded → the sequencer requests
 *      $89.52, NOT $116.41.
 *   2. `issueRefund`'s double-refund guard is DELEGATED to (not re-implemented)
 *      — we pass a stable `requestKey` per action so the same-shape retry
 *      short-circuits inside `refundOrder`'s pre-dispatch ledger read. The
 *      test verifies (a) the requestKey is threaded through, and (b) the
 *      sequencer's SMS + refund calls fire in the correct order (SMS first,
 *      refund second).
 *   3. The internal audit note records BOTH the full refund amount AND the
 *      founder cancel-SMS with the order number.
 *
 * Plus the non-rejected-swap short-circuit (no refund fires on a
 * `swap_accepted` classification — safety net for the Phase 1 gate) and the
 * customer-voice discipline check (never claims an action the system didn't
 * actually perform).
 *
 * Run:
 *   npx tsx --test src/lib/commerce/crisis-swap-rejected-sequencer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCustomerReplyDraft,
  buildInternalNote,
  executeCrisisSwapRejectedRemedy,
  type CrisisSwapRejectedRemedyDeps,
  type CrisisSwapRejectedOrderRow,
} from "./crisis-swap-rejected-sequencer";
import type { RefundMethod } from "./refund";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const TICKET_ID = "33333333-3333-3333-3333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-4444-444444444444";
const SWAP_VARIANT = "variant-tropical-swap";
const AFFECTED_VARIANT = "variant-mixed-berry";

// The Cheri case cited in the spec — $116.41 total, $26.89 already refunded.
const CHERI_TOTAL_CENTS = 11641;
const CHERI_PRIOR_REFUND_CENTS = 2689;
const CHERI_EXPECTED_REMAINDER = CHERI_TOTAL_CENTS - CHERI_PRIOR_REFUND_CENTS; // 8952

const CHERI_ORDER: CrisisSwapRejectedOrderRow = {
  id: ORDER_ID,
  order_number: "1099",
  total_cents: CHERI_TOTAL_CENTS,
  amplifier_status: "Processing Shipment",
  line_items: [{ variant_id: SWAP_VARIANT, title: "Tropical (swap)" }],
};

const ACTIVE_CRISIS = {
  id: "crisis-berry",
  status: "active",
  affected_variant_id: AFFECTED_VARIANT,
  default_swap_variant_id: SWAP_VARIANT,
  affected_product_title: "Mixed Berry",
  expected_restock_date: "2026-09-01",
} as const;

// ── Stubs (call-order-recording spies) ───────────────────────────────────
interface CallRecord {
  step: string;
  payload: Record<string, unknown>;
}
function makeSpyDeps(overrides?: {
  refundResult?: { success: boolean; error?: string; method?: RefundMethod; refund_id?: string };
  smsResult?: { sent: boolean; reason?: string; order_number?: string | null };
  priorRefundsCents?: number;
  order?: CrisisSwapRejectedOrderRow | null;
}): { deps: CrisisSwapRejectedRemedyDeps; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const deps: CrisisSwapRejectedRemedyDeps = {
    loadOrder: async () => {
      calls.push({ step: "loadOrder", payload: {} });
      return overrides?.order === undefined ? CHERI_ORDER : overrides.order;
    },
    sumPriorRefunds: async () => {
      const v = overrides?.priorRefundsCents ?? CHERI_PRIOR_REFUND_CENTS;
      calls.push({ step: "sumPriorRefunds", payload: { returned: v } });
      return v;
    },
    sendFounderCancelAmplifierSMS: async () => {
      const r = overrides?.smsResult ?? { sent: true, order_number: CHERI_ORDER.order_number };
      calls.push({ step: "sendFounderCancelAmplifierSMS", payload: { returned: r } });
      return r;
    },
    issueRefund: async (workspaceId, args) => {
      calls.push({
        step: "issueRefund",
        payload: {
          workspaceId,
          orderId: args.orderId,
          amountCents: args.amountCents,
          requestKey: args.requestKey,
          reason: args.reason,
        },
      });
      const r = overrides?.refundResult ?? { success: true, method: "braintree", refund_id: "bt-1" };
      return r;
    },
    hashActionRefundKey: (scope, id, orderId, amount, reason) => {
      return `stub:${scope}:${id}:${orderId}:${amount}:${reason.slice(0, 8)}`;
    },
  };
  return { deps, calls };
}

const admin = {} as never;

// ── Tests ────────────────────────────────────────────────────────────────

test("Cheri case: refund amount = order_total − prior refunds (never the full total)", async () => {
  const { deps, calls } = makeSpyDeps();
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "I only want mixed berry — no substitutions, I'll wait for it to come back.",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );

  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(r.refund.fired, true);
  assert.equal(r.refund.success, true);
  assert.equal(
    r.refund.amount_cents,
    CHERI_EXPECTED_REMAINDER,
    `should refund the remainder $${(CHERI_EXPECTED_REMAINDER / 100).toFixed(2)}, NOT the full $${(CHERI_TOTAL_CENTS / 100).toFixed(2)}`,
  );
  assert.equal(r.refund.prior_refunded_cents, CHERI_PRIOR_REFUND_CENTS);
  assert.equal(r.refund.order_total_cents, CHERI_TOTAL_CENTS);

  const refundCall = calls.find((c) => c.step === "issueRefund");
  assert.ok(refundCall, "issueRefund must be called");
  assert.equal(refundCall.payload.amountCents, CHERI_EXPECTED_REMAINDER);
});

test("Phase-3 Verification #2a: SMS fires FIRST, refund fires SECOND — spec sequence", async () => {
  const { deps, calls } = makeSpyDeps();
  await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only please, no substitutes",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );

  const smsIdx = calls.findIndex((c) => c.step === "sendFounderCancelAmplifierSMS");
  const refundIdx = calls.findIndex((c) => c.step === "issueRefund");
  assert.notEqual(smsIdx, -1, "founder cancel-SMS must fire");
  assert.notEqual(refundIdx, -1, "issueRefund must fire");
  assert.ok(smsIdx < refundIdx, "spec sequence: SMS FIRST, refund SECOND");
});

test("Phase-3 Verification #2b: issueRefund receives a stable action-scoped requestKey (delegated double-refund guard)", async () => {
  const { deps, calls } = makeSpyDeps();
  await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only please",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  const refundCall = calls.find((c) => c.step === "issueRefund");
  assert.ok(refundCall);
  const rk = refundCall.payload.requestKey as string;
  assert.ok(rk?.startsWith("stub:sol:"), `requestKey ${rk} must be action-scoped ('sol' actor)`);
  assert.ok(rk.includes(TICKET_ID), "ticket-scoped so a retry of the SAME remedy computes the SAME key");
  assert.ok(rk.includes(String(CHERI_EXPECTED_REMAINDER)), "amount is part of the key");
});

test("Phase-3 Verification #2c: retry of SAME remedy computes the SAME requestKey (short-circuits the double-refund guard)", async () => {
  const { deps: d1, calls: c1 } = makeSpyDeps();
  const { deps: d2, calls: c2 } = makeSpyDeps();
  const argsCommon = {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ticketId: TICKET_ID,
    customerId: CUSTOMER_ID,
    customerMessageText: "berry only",
    crisis: ACTIVE_CRISIS,
  };
  await executeCrisisSwapRejectedRemedy(admin, argsCommon, d1);
  await executeCrisisSwapRejectedRemedy(admin, argsCommon, d2);
  const k1 = (c1.find((c) => c.step === "issueRefund")?.payload.requestKey as string) ?? "";
  const k2 = (c2.find((c) => c.step === "issueRefund")?.payload.requestKey as string) ?? "";
  assert.equal(k1, k2, "same remedy shape → same requestKey → refundOrder's guard short-circuits the second attempt");
});

test("Phase-3 Verification #3: internal note records BOTH the refund amount AND the SMS with order_number", async () => {
  const { deps } = makeSpyDeps();
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.match(r.internal_note, /^crisis-swap-rejected:/);
  assert.match(r.internal_note, /full refund \$89\.52/, "note quotes the exact refund amount");
  assert.match(r.internal_note, /founder texted to cancel 1099/, "note names the order number the founder was texted about");
});

test("swap-accepted classification → sequencer skips (no SMS, no refund)", async () => {
  const { deps, calls } = makeSpyDeps();
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "the swap is fine",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.equal(r.classification, "swap_accepted");
  assert.equal(r.refund.fired, false);
  assert.equal(r.refund.amount_cents, 0);
  assert.equal(calls.find((c) => c.step === "sendFounderCancelAmplifierSMS"), undefined);
  assert.equal(calls.find((c) => c.step === "issueRefund"), undefined);
  assert.match(r.internal_note, /skipped \(swap_accepted\)/);
  assert.equal(r.customer_reply_draft, "");
});

test("prior refunds ≥ order_total → refund not fired (already fully refunded); note reflects it", async () => {
  const { deps, calls } = makeSpyDeps({ priorRefundsCents: CHERI_TOTAL_CENTS });
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only please",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(r.refund.fired, false, "no vendor call when nothing left to refund");
  assert.equal(r.refund.success, true, "the state is correct — order is fully refunded");
  assert.equal(r.refund.amount_cents, 0);
  assert.equal(calls.find((c) => c.step === "issueRefund"), undefined, "issueRefund not called with $0");
});

test("Shipped-anyway guardrail: SMS emitter says Shipped → refund STILL proceeds (return-on-receipt in parallel)", async () => {
  const { deps, calls } = makeSpyDeps({
    smsResult: { sent: false, reason: "order already Shipped in Amplifier — return path, not founder cancel" },
  });
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only, I'll wait",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.equal(r.sms.sent, false);
  assert.equal(r.refund.fired, true, "refund still proceeds — a Shipped order is still owed the customer");
  assert.equal(r.refund.amount_cents, CHERI_EXPECTED_REMAINDER);
  assert.ok(calls.find((c) => c.step === "issueRefund"));
  assert.match(r.internal_note, /already Shipped in Amplifier — return path/);
  assert.match(r.internal_note, /full refund \$89\.52/);
});

test("refund vendor failure → internal note is honest; customer reply DOES NOT claim the refund landed", async () => {
  const { deps } = makeSpyDeps({
    refundResult: { success: false, error: "braintree gateway timeout" },
  });
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only, no substitutes",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.equal(r.refund.fired, true);
  assert.equal(r.refund.success, false);
  assert.match(r.refund.error ?? "", /braintree gateway timeout/);
  assert.match(r.internal_note, /FAILED \(braintree gateway timeout\)/);
  assert.doesNotMatch(r.customer_reply_draft, /refunded/i, "customer-voice: never claim an action the system didn't perform");
  assert.match(r.customer_reply_draft, /getting the refund set up now/i);
});

test("customer reply draft (success): acknowledges OOS + refund + paused, does NOT over-apologize or expose order numbers", async () => {
  const draft = buildCustomerReplyDraft({
    refundFired: true,
    refundSucceeded: true,
    amountCents: CHERI_EXPECTED_REMAINDER,
    affectedProductTitle: "Mixed Berry",
    restockDateISO: "2026-09-01",
  });
  assert.match(draft, /Mixed Berry/, "names the OOS product");
  assert.match(draft, /refunded the \$89\.52/, "names the refund amount");
  assert.match(draft, /subscription is paused/, "names the paused-until-restock outcome");
  assert.doesNotMatch(draft, /sorry|apologi[sz]e/i, "customer-voice: no over-apologizing for normal process");
  assert.doesNotMatch(draft, /1099/, "customer-voice: no internal order numbers in customer-visible text");
});

test("order not found → sequencer bails gracefully (no throw, no SMS, no refund)", async () => {
  const { deps, calls } = makeSpyDeps({ order: null });
  const r = await executeCrisisSwapRejectedRemedy(
    admin,
    {
      workspaceId: WORKSPACE_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      customerId: CUSTOMER_ID,
      customerMessageText: "berry only",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.equal(r.classification, "no_match");
  assert.equal(r.refund.fired, false);
  assert.equal(calls.find((c) => c.step === "sendFounderCancelAmplifierSMS"), undefined);
  assert.equal(calls.find((c) => c.step === "issueRefund"), undefined);
});

test("buildInternalNote unit: covers every SMS disposition truthfully", () => {
  const refundOk = {
    fired: true,
    success: true,
    amount_cents: 8952,
    prior_refunded_cents: 2689,
    order_total_cents: 11641,
  };
  const noteSent = buildInternalNote({
    refund: refundOk,
    sms: { sent: true, order_number: "1099" },
    orderNumber: "1099",
  });
  assert.match(noteSent, /founder texted to cancel 1099/);

  const noteShipped = buildInternalNote({
    refund: refundOk,
    sms: { sent: false, reason: "order already Shipped in Amplifier — return path" },
    orderNumber: "1099",
  });
  assert.match(noteShipped, /already Shipped in Amplifier/);

  const noteAlreadyTexted = buildInternalNote({
    refund: refundOk,
    sms: { sent: false, reason: "founder cancel-SMS already sent for this order — not re-texting" },
    orderNumber: "1099",
  });
  assert.match(noteAlreadyTexted, /already texted about 1099/);

  const noteNoPhone = buildInternalNote({
    refund: refundOk,
    sms: { sent: false, reason: "no founder phone configured" },
    orderNumber: "1099",
  });
  assert.match(noteNoPhone, /no founder phone configured/);
});
