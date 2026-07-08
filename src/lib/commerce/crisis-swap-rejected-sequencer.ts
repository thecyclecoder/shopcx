/**
 * Crisis-swap-rejected remedy SEQUENCER — Phase 3 of
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * Composes Phase 1 (the pure classifier — [[./crisis-swap-rejected]]) and
 * Phase 2 (the founder Amplifier-cancel SMS — [[./founder-cancel-sms]]) into
 * one supervised sequence Sol runs after her direction commits:
 *
 *   1. Read the order (`total_cents`, `order_number`, `line_items`, `amplifier_status`).
 *   2. Sum prior refunds against the order (`order_refunds` ledger — status in
 *      `succeeded` / `settled`) so the full-refund amount NEVER exceeds
 *      `order.total_cents − prior_refunded_cents`. The Cheri case cited in the
 *      spec is the canary: $116.41 total, $26.89 already refunded → refund the
 *      remaining $89.52, NOT the full $116.41.
 *   3. Classify via [[./crisis-swap-rejected]] `classifyCrisisSwap`. Anything
 *      other than `crisis_swap_rejected` short-circuits with a `skipped_reason`
 *      — the sequencer NEVER refunds a customer who accepted the swap.
 *   4. Fire the founder cancel-SMS FIRST ([[./founder-cancel-sms]]
 *      `sendFounderCancelAmplifierSMS`) — the spec's sequence is deliberate:
 *      the founder's manual cancel in Amplifier is time-boxed (before Shipped);
 *      the refund can happen at any point, so it goes SECOND. The SMS emitter
 *      is best-effort + never-throws + Shipped-guarded, so a Shipped order
 *      lands `sent:false / reason:'…Shipped…'` and the refund still proceeds.
 *   5. Issue the full refund via [[./refund]] `issueRefund` (which delegates to
 *      the gateway-aware [[../refund]] `refundOrder` — double-refund guard is
 *      built in via `order_refunds` request_key uniqueness; a same-shape retry
 *      short-circuits without a second gateway call).
 *   6. Emit the truthful internal audit note (`crisis-swap-rejected: full
 *      refund $X + founder texted to cancel {order_number}`) — captures BOTH
 *      the refund amount and the SMS disposition (sent / already-shipped /
 *      already-texted / no-phone) so the timeline entry is honest.
 *   7. Emit the customer-voice-shaped reply draft — acknowledges the OOS + the
 *      full refund + the paused-until-restock outcome without over-apologizing
 *      (per [[../../../docs/brain/customer-voice]] "What NOT to apologize for":
 *      crisis swaps are normal process we communicated up front). Plain text,
 *      max 2 sentences per paragraph, no order/sub numbers in customer-visible
 *      text.
 *
 * Injectable-deps discipline mirrors [[./replacement]] `issueDollarReplacement`
 * — real callers omit `_deps` and get the production wiring; the node:test
 * harness overrides each so the test never boots Supabase / Braintree.
 *
 * NEVER throws — a failing sub-step lands in the `refund.error` / `sms.reason`
 * field; the caller (Sol's box session) decides whether to escalate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  classifyCrisisSwap,
  type CrisisSwapClassification,
  type CrisisSwapRejectedCrisisInput,
  type CrisisSwapRejectedOrderInput,
} from "./crisis-swap-rejected";
import type { IssueRefundResult } from "./refund";
import type { FounderCancelAmplifierSMSResult } from "./founder-cancel-sms";

type Admin = SupabaseClient;

/** The order row shape the sequencer needs — narrower than the full orders table. */
export interface CrisisSwapRejectedOrderRow {
  id: string;
  order_number: string | null;
  total_cents: number;
  amplifier_status: string | null;
  line_items: Array<{ variant_id?: string | number | null; title?: string | null }>;
}

/**
 * Sequencer-side crisis input — a superset of the Phase-1 classifier's minimum
 * (`id, status, affected_variant_id, default_swap_variant_id`) that ALSO carries
 * the customer-reply framing fields the classifier does not need. Kept local to
 * the sequencer so Phase 1's classifier surface stays unchanged.
 */
export interface CrisisSwapRejectedSequencerCrisis extends CrisisSwapRejectedCrisisInput {
  affected_product_title?: string | null;
  expected_restock_date?: string | null;
}

export interface CrisisSwapRejectedSequencerArgs {
  workspaceId: string;
  orderId: string;
  customerId?: string | null;
  ticketId?: string | null;
  /** The customer's most recent inbound message — fed into the Phase 1 classifier. */
  customerMessageText: string | null;
  /** The prefetched active crisis (typically hydrated from the caller's context). */
  crisis: CrisisSwapRejectedSequencerCrisis | null;
}

export interface CrisisSwapRejectedRefundOutcome {
  fired: boolean;
  success: boolean;
  amount_cents: number;
  prior_refunded_cents: number;
  order_total_cents: number;
  method?: string;
  refund_id?: string;
  error?: string;
}

export interface CrisisSwapRejectedRemedyResult {
  classification: CrisisSwapClassification;
  refund: CrisisSwapRejectedRefundOutcome;
  sms: FounderCancelAmplifierSMSResult;
  /** The truthful internal audit note — the caller writes this to the timeline. */
  internal_note: string;
  /** Customer-voice reply draft — the caller sends this (or edits + sends). */
  customer_reply_draft: string;
  /** Populated when classification !== 'crisis_swap_rejected'. */
  skipped_reason?: string;
}

export interface CrisisSwapRejectedRemedyDeps {
  loadOrder: (
    admin: Admin,
    workspaceId: string,
    orderId: string,
  ) => Promise<CrisisSwapRejectedOrderRow | null>;
  sumPriorRefunds: (
    admin: Admin,
    workspaceId: string,
    orderId: string,
  ) => Promise<number>;
  issueRefund: (
    workspaceId: string,
    args: {
      orderId: string;
      amountCents: number;
      reason: string;
      source?: string;
      customerId?: string | null;
      eventProperties?: Record<string, unknown>;
      requestKey?: string;
    },
  ) => Promise<IssueRefundResult>;
  sendFounderCancelAmplifierSMS: (
    admin: Admin,
    args: { workspaceId: string; orderId: string },
  ) => Promise<FounderCancelAmplifierSMSResult>;
  hashActionRefundKey: (
    actorScope: string,
    actorId: string,
    orderId: string,
    amountCents: number,
    reason: string,
  ) => string;
}

/** Format cents as `$X.YY` — internal-audit / note formatting only. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Compose the truthful internal note the caller writes to the ticket timeline.
 * Captures BOTH the refund half and the SMS disposition so a reviewer can see
 * WHICH order the founder was asked to cancel — the spec's shape:
 *   `crisis-swap-rejected: full refund $X + founder texted to cancel {order_number}`
 *
 * When the SMS did NOT fire (already Shipped / already texted / no phone), the
 * note is honest about that too — the reply says "Shipped → return path" rather
 * than claiming an SMS that never happened (matches [[../../../docs/brain/customer-voice]]
 * "Never claim an action the system didn't actually perform").
 */
export function buildInternalNote(input: {
  refund: CrisisSwapRejectedRefundOutcome;
  sms: FounderCancelAmplifierSMSResult;
  orderNumber: string | null;
}): string {
  const orderLabel = input.orderNumber || "order";
  const refundPart = input.refund.fired
    ? input.refund.success
      ? `full refund ${dollars(input.refund.amount_cents)}`
      : `full refund attempt ${dollars(input.refund.amount_cents)} FAILED (${input.refund.error ?? "unknown"})`
    : "refund not fired";
  let smsPart: string;
  if (input.sms.sent) {
    smsPart = `founder texted to cancel ${orderLabel}`;
  } else if (input.sms.reason && /Shipped/i.test(input.sms.reason)) {
    smsPart = `${orderLabel} already Shipped in Amplifier — return path`;
  } else if (input.sms.reason && /already sent/i.test(input.sms.reason)) {
    smsPart = `founder already texted about ${orderLabel} — not re-texting`;
  } else if (input.sms.reason && /no founder phone/i.test(input.sms.reason)) {
    smsPart = `no founder phone configured — cancel-SMS skipped`;
  } else {
    smsPart = `cancel-SMS: ${input.sms.reason ?? "not sent"}`;
  }
  return `crisis-swap-rejected: ${refundPart} + ${smsPart}`;
}

/**
 * Compose the customer-voice reply draft. Discipline (per
 * [[../../../docs/brain/customer-voice]]):
 *   - Short paragraphs, max 2 sentences.
 *   - Plain text (the caller wraps in `<p>` for HTML surfaces).
 *   - No apology for the crisis swap — normal process we communicated.
 *   - No order number in the customer-visible text.
 *   - Lead with the outcome, not a menu.
 *   - Never claim an SMS the system didn't send; the customer-facing
 *     text says nothing about the founder cancel-SMS regardless.
 *
 * A refund that failed produces a DIFFERENT reply — we NEVER tell the customer
 * "your refund is on its way" when the vendor returned an error.
 */
export function buildCustomerReplyDraft(input: {
  refundFired: boolean;
  refundSucceeded: boolean;
  amountCents: number;
  affectedProductTitle: string | null;
  restockDateISO: string | null;
}): string {
  const product = (input.affectedProductTitle || "the item you ordered").trim();
  const restockLine = input.restockDateISO
    ? ` We'll restart your subscription automatically once ${product} is back — the current estimate is ${formatRestockDate(input.restockDateISO)}.`
    : ` We'll restart your subscription automatically once ${product} is back in stock.`;

  if (input.refundFired && input.refundSucceeded) {
    return [
      `Got it — since ${product} is out of stock and you'd rather wait than take the substitute, I've refunded the ${dollars(
        input.amountCents,
      )} in full to your original payment method.`,
      `Your subscription is paused in the meantime.${restockLine}`,
    ].join("\n\n");
  }

  // Refund did not fire OR failed — never claim an action the system didn't do.
  return [
    `Got it — since ${product} is out of stock and you'd rather wait than take the substitute, I'm getting the refund set up now and will confirm as soon as it clears.`,
    `Your subscription is paused in the meantime.${restockLine}`,
  ].join("\n\n");
}

function formatRestockDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } catch {
    return "later this year";
  }
}

async function defaultDeps(): Promise<CrisisSwapRejectedRemedyDeps> {
  const [{ issueRefund }, { sendFounderCancelAmplifierSMS }, refundModule] = await Promise.all([
    import("./refund"),
    import("./founder-cancel-sms"),
    import("@/lib/refund"),
  ]);
  return {
    loadOrder: async (admin, workspaceId, orderId) => {
      const { data } = await admin
        .from("orders")
        .select("id, order_number, total_cents, amplifier_status, line_items")
        .eq("workspace_id", workspaceId)
        .eq("id", orderId)
        .maybeSingle();
      return (data as CrisisSwapRejectedOrderRow | null) ?? null;
    },
    sumPriorRefunds: async (admin, workspaceId, orderId) => {
      // `order_refunds` mirror ledger — sum every succeeded/settled row for
      // this (workspace, order). Scoped by workspace_id so a cross-workspace
      // order id collision can't leak into the sum (learning #6).
      const { data } = await admin
        .from("order_refunds")
        .select("amount_cents, status")
        .eq("workspace_id", workspaceId)
        .eq("order_id", orderId)
        .in("status", ["succeeded", "settled"]);
      const rows = (data as { amount_cents: number | null }[] | null) ?? [];
      return rows.reduce((s, r) => s + (r.amount_cents ?? 0), 0);
    },
    issueRefund,
    sendFounderCancelAmplifierSMS,
    hashActionRefundKey: refundModule.hashActionRefundKey,
  };
}

/**
 * Run the crisis-swap-rejected remedy end-to-end. Returns the full outcome —
 * the caller decides how to render (append the internal note, send the
 * customer reply draft, escalate on refund.error). Injectable deps for the
 * atomicity harness.
 */
export async function executeCrisisSwapRejectedRemedy(
  admin: Admin,
  args: CrisisSwapRejectedSequencerArgs,
  _deps?: Partial<CrisisSwapRejectedRemedyDeps>,
): Promise<CrisisSwapRejectedRemedyResult> {
  const deps: CrisisSwapRejectedRemedyDeps = { ...(await defaultDeps()), ..._deps };

  const order = await deps.loadOrder(admin, args.workspaceId, args.orderId);
  if (!order) {
    return {
      classification: "no_match",
      refund: {
        fired: false,
        success: false,
        amount_cents: 0,
        prior_refunded_cents: 0,
        order_total_cents: 0,
        error: "order not found",
      },
      sms: { sent: false, reason: "order not found" },
      internal_note: "crisis-swap-rejected: skipped — order not found",
      customer_reply_draft: "",
      skipped_reason: "order not found",
    };
  }

  const priorRefunds = await deps.sumPriorRefunds(admin, args.workspaceId, args.orderId);

  const classifierInput: {
    crisis: CrisisSwapRejectedCrisisInput | null;
    order: CrisisSwapRejectedOrderInput | null;
    message: { text: string } | null;
  } = {
    crisis: args.crisis,
    order: {
      id: order.id,
      order_number: order.order_number,
      total_cents: order.total_cents,
      prior_refunded_cents: priorRefunds,
      line_items: order.line_items,
    },
    message: { text: args.customerMessageText ?? "" },
  };
  const classification = classifyCrisisSwap(classifierInput);

  // Short-circuit any non-rejected classification — the sequencer NEVER
  // refunds a customer who accepted the swap or asked for a different in-stock
  // flavor. The reason field is echoed straight into the internal note so a
  // reviewer can trace WHY the remedy skipped.
  if (classification.classification !== "crisis_swap_rejected" || !classification.refund_plan) {
    return {
      classification: classification.classification,
      refund: {
        fired: false,
        success: false,
        amount_cents: 0,
        prior_refunded_cents: priorRefunds,
        order_total_cents: order.total_cents,
      },
      sms: { sent: false, reason: "not classified as crisis-swap-rejected" },
      internal_note: `crisis-swap-rejected: skipped (${classification.classification}) — ${classification.reason}`,
      customer_reply_draft: "",
      skipped_reason: classification.reason,
    };
  }

  const amountCents = classification.refund_plan.amount_cents;

  // ── STEP 1: fire the founder cancel-SMS FIRST (spec sequence) ────────────
  //
  // The emitter is best-effort + never-throws + Shipped-guarded, so even a
  // Shipped order lands `sent:false / reason:'…Shipped…'` here — the refund
  // still proceeds (a Shipped order is a return-on-receipt case; we still owe
  // the customer the money either way, they just wait for delivery to trigger
  // the return path in parallel).
  const sms = await deps.sendFounderCancelAmplifierSMS(admin, {
    workspaceId: args.workspaceId,
    orderId: args.orderId,
  });

  // ── STEP 2: issue the full refund via the SDK facade ─────────────────────
  //
  // Passing an action-scoped requestKey through so a same-action retry
  // (Inngest step retry, ticket-re-dispatch, self-heal) computes the SAME
  // key and short-circuits inside `refundOrder`'s pre-dispatch order_refunds
  // guard — no second gateway call, no double refund. Scope key: the
  // ticket_id when present, else the order id (both stable per remedy).
  const actorId = args.ticketId ?? args.orderId;
  const reason = classification.refund_plan.reason;
  const requestKey = deps.hashActionRefundKey("sol", actorId, args.orderId, amountCents, reason);

  let refundOutcome: CrisisSwapRejectedRefundOutcome;
  if (amountCents <= 0) {
    // Order already fully refunded (prior refunds sum to ≥ order_total). The
    // double-refund guard would short-circuit anyway, but the sequencer bails
    // BEFORE the vendor call so the internal note reads truthfully.
    refundOutcome = {
      fired: false,
      success: true,
      amount_cents: 0,
      prior_refunded_cents: priorRefunds,
      order_total_cents: order.total_cents,
    };
  } else {
    const r = await deps.issueRefund(args.workspaceId, {
      orderId: args.orderId,
      amountCents,
      reason,
      source: "sol",
      customerId: args.customerId ?? null,
      eventProperties: {
        ticket_id: args.ticketId ?? null,
        classification: "crisis_swap_rejected",
        remedy: "phase-3-sequencer",
        order_total_cents: order.total_cents,
        prior_refunded_cents: priorRefunds,
      },
      requestKey,
    });
    refundOutcome = {
      fired: true,
      success: r.success,
      amount_cents: amountCents,
      prior_refunded_cents: priorRefunds,
      order_total_cents: order.total_cents,
      method: r.method,
      refund_id: r.refund_id,
      error: r.error,
    };
  }

  const internal_note = buildInternalNote({
    refund: refundOutcome,
    sms,
    orderNumber: order.order_number,
  });

  const customer_reply_draft = buildCustomerReplyDraft({
    refundFired: refundOutcome.fired,
    refundSucceeded: refundOutcome.success,
    amountCents,
    affectedProductTitle: args.crisis?.affected_product_title ?? null,
    restockDateISO: args.crisis?.expected_restock_date ?? null,
  });

  return {
    classification: "crisis_swap_rejected",
    refund: refundOutcome,
    sms,
    internal_note,
    customer_reply_draft,
  };
}
