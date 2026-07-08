/**
 * Async-aware order-now verify — Phase 1 of docs/brain/specs/order-now-verify-async-result-then-decline-recovery-migrate-and-deterministic-retry.md
 *
 * Order-now / bill_now is IMMEDIATE for internal (Braintree) subs but DELAYED
 * for Appstle: the vendor accepts the trigger, then charges asynchronously and
 * can DECLINE minutes later. `subscriptionOrderNow` reports success on the
 * trigger ack alone, so a later decline is invisible — the customer already
 * got told "it shipped" (ticket 0a9e4d7f — Judy).
 *
 * This library fixes that: after firing order-now we schedule
 * `commerce/order-now.verify` on Inngest so the REAL outcome (order paid vs
 * billing-failure / dunning) is read minutes later and only THEN stamps the
 * ticket_resolution_events row with a real verdict. Internal subs verify with
 * a short delay too (the renewal-attempt pipeline still runs async in Inngest)
 * but on the same code path, so every order-now is confirmed by a real paid
 * order — never by a trigger ack.
 *
 * Split into three pure-testable pieces + one wrapper:
 *
 *   1. `computeOrderNowVerdict(input)` — pure predicate. Given evidence
 *      (billing-failure / billing-success events, last_payment_status, new
 *      paid orders since fired_at) returns 'paid' | 'declined' | 'unknown'.
 *   2. `verifyOrderNowOutcome(admin, opts)` — reads the evidence from
 *      customer_events + subscriptions + orders and calls the predicate.
 *   3. `subscriptionOrderNowVerified(workspaceId, contractId, opts)` — fires
 *      the underlying `subscriptionOrderNow` AND schedules the delayed verify.
 *      Returns `{ success, internal, pending, fired_at }` — `pending: true`
 *      for Appstle (real outcome not yet known), `false` for internal (still
 *      scheduled, but the pipeline is our own code).
 *   4. `scheduleOrderNowVerify(opts)` — the fire-the-Inngest-event helper.
 *      Extracted so the caller list (bill_now direct action, portal, ticket
 *      UI) all schedule the same way.
 *
 * The Inngest function itself lives at `src/lib/inngest/order-now-verify.ts`.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { subscriptionOrderNow } from "@/lib/commerce/subscription";

// ── Evidence + verdict ────────────────────────────────────────────

export type OrderNowVerdict = "paid" | "declined" | "unknown";

/** Evidence collected from the DB about the async outcome. */
export interface OrderNowEvidence {
  /** A customer_events row of type 'subscription.billing-failure' with
   *  properties.shopify_contract_id = ours, created_at > fired_at. */
  hasBillingFailureEvent: boolean;
  /** A customer_events row of type 'subscription.billing-success' with
   *  properties.shopify_contract_id = ours, created_at > fired_at. */
  hasBillingSuccessEvent: boolean;
  /** Current subscriptions.last_payment_status — 'succeeded' means the
   *  Appstle billing-success webhook (or internal pipeline) has landed. */
  lastPaymentStatus: string | null;
  /** An orders row with subscription_id = ours and created_at > fired_at
   *  and financial_status = 'paid' — the real proof of a successful charge. */
  hasNewPaidOrder: boolean;
}

/**
 * Pure predicate mapping evidence → verdict. Extracted so tests can pin the
 * decision table without spinning Supabase:
 *
 * - declined: any billing-failure event, OR last_payment_status='failed'
 *   without a competing paid order.
 * - paid: a new paid order after fired_at, OR a billing-success event.
 * - unknown: neither has landed yet — the caller should schedule one more
 *   re-check.
 *
 * If both failure AND success/paid-order evidence are present (rare: card
 * rotation between the fire and the verify) we resolve to 'paid' — the
 * customer's account state ends up ok.
 */
export function computeOrderNowVerdict(input: OrderNowEvidence): OrderNowVerdict {
  const paidSignal = input.hasNewPaidOrder
    || input.hasBillingSuccessEvent
    || input.lastPaymentStatus === "succeeded";
  const declinedSignal = input.hasBillingFailureEvent
    || input.lastPaymentStatus === "failed";

  if (paidSignal) return "paid";
  if (declinedSignal) return "declined";
  return "unknown";
}

// ── DB reader ─────────────────────────────────────────────────────

/**
 * Read the evidence for a specific (subscription, fired_at) pair and compute
 * the verdict. Wrapped so callers (the Inngest function, tests, ad-hoc
 * scripts) share one query surface.
 *
 * Missing subscription → verdict 'unknown' (the caller schedules one more
 * re-check; a genuinely deleted sub falls into the unknown-terminal bucket).
 */
export async function verifyOrderNowOutcome(
  admin: ReturnType<typeof createAdminClient>,
  opts: {
    workspace_id: string;
    subscription_id: string;
    contract_id: string;
    fired_at: string;
  },
): Promise<{ verdict: OrderNowVerdict; evidence: OrderNowEvidence }> {
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, last_payment_status")
    .eq("workspace_id", opts.workspace_id)
    .eq("id", opts.subscription_id)
    .maybeSingle();

  const lastPaymentStatus = (sub?.last_payment_status as string | null) ?? null;

  const { count: failureCount } = await admin
    .from("customer_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", opts.workspace_id)
    .eq("event_type", "subscription.billing-failure")
    .eq("properties->>shopify_contract_id", opts.contract_id)
    .gt("created_at", opts.fired_at);

  const { count: successCount } = await admin
    .from("customer_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", opts.workspace_id)
    .eq("event_type", "subscription.billing-success")
    .eq("properties->>shopify_contract_id", opts.contract_id)
    .gt("created_at", opts.fired_at);

  const { count: paidOrderCount } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", opts.workspace_id)
    .eq("subscription_id", opts.subscription_id)
    .eq("financial_status", "paid")
    .gt("created_at", opts.fired_at);

  const evidence: OrderNowEvidence = {
    hasBillingFailureEvent: (failureCount ?? 0) > 0,
    hasBillingSuccessEvent: (successCount ?? 0) > 0,
    lastPaymentStatus,
    hasNewPaidOrder: (paidOrderCount ?? 0) > 0,
  };

  return { verdict: computeOrderNowVerdict(evidence), evidence };
}

// ── Schedule + fire ───────────────────────────────────────────────

/** Callers hand us these fields; we thread them through so the async
 *  verify can stamp back to the same resolution-event row + ticket. */
export interface OrderNowVerifyContext {
  /** ticket_resolution_events.id to stamp verified_at + verified_outcome
   *  once the real result is known. Optional (portal/CLI callers have no
   *  resolution event to stamp — the verify still runs, just no stamp). */
  resolution_event_id?: string;
  /** For logging + Phase 2's decline-journey trigger. */
  ticket_id?: string;
  /** For Phase 2's decline-journey — the customer we send the
   *  update-payment-method journey to. */
  customer_id?: string;
}

/** Fire the `commerce/order-now.verify` Inngest event with a delay picked
 *  from the sub flavor. Kept separate from `subscriptionOrderNowVerified` so
 *  callers that already fired order-now their own way (portal handlers) can
 *  still schedule the verify. */
export async function scheduleOrderNowVerify(input: {
  workspace_id: string;
  subscription_id: string;
  contract_id: string;
  fired_at: string;
  is_internal: boolean;
  attempt?: number;
} & OrderNowVerifyContext): Promise<void> {
  await inngest.send({
    name: "commerce/order-now.verify",
    data: {
      workspace_id: input.workspace_id,
      subscription_id: input.subscription_id,
      contract_id: input.contract_id,
      fired_at: input.fired_at,
      is_internal: input.is_internal,
      resolution_event_id: input.resolution_event_id ?? null,
      ticket_id: input.ticket_id ?? null,
      customer_id: input.customer_id ?? null,
      attempt: input.attempt ?? 1,
    },
  });
}

/** Return shape of `subscriptionOrderNowVerified`. Mirrors the underlying
 *  `subscriptionOrderNow` OpResult shape and adds `pending` (true = the real
 *  charge outcome is not yet known; the async verify will land the verdict)
 *  and `fired_at` (the ISO timestamp used as the async verify's cursor). */
export interface OrderNowVerifiedResult {
  success: boolean;
  error?: string;
  summary?: string;
  internal: boolean;
  pending: boolean;
  fired_at: string;
  subscription_id?: string;
}

/**
 * Fires order-now via `subscriptionOrderNow` AND schedules the async verify
 * — the caller pattern that keeps every order-now confirmed by a REAL paid
 * order (not the trigger ack).
 *
 * Behavior:
 *  - Missing sub → returns success:false, does NOT schedule a verify.
 *  - Internal sub → returns `pending: false` (renewal pipeline is our code;
 *    resolution stamp can land at handler-return time) — but STILL schedules
 *    the verify at a short delay so the resolution-event verdict is
 *    ground-truthed by a real paid order.
 *  - Appstle sub → returns `pending: true` (the real charge is minutes away;
 *    caller MUST leave the resolution_event verified_outcome NULL and let
 *    the async verify stamp it).
 *  - `subscriptionOrderNow` failure → returns the failure verbatim (no
 *    verify scheduled — nothing to verify).
 */
export async function subscriptionOrderNowVerified(
  workspaceId: string,
  contractId: string,
  ctx: OrderNowVerifyContext = {},
): Promise<OrderNowVerifiedResult> {
  const admin = createAdminClient();
  const firedAt = new Date().toISOString();

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, is_internal, status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();

  if (!sub) {
    return {
      success: false,
      error: "subscription_not_found",
      internal: false,
      pending: false,
      fired_at: firedAt,
    };
  }

  const isInternal = Boolean(sub.is_internal);

  // Fire the underlying order-now. Preserves the Braintree-vs-Appstle branch
  // in the shared `subscriptionOrderNow` — this wrapper only adds the verify.
  const fired = await subscriptionOrderNow(workspaceId, contractId);
  if (!fired.success) {
    return {
      success: false,
      error: fired.error,
      summary: fired.summary,
      internal: isInternal,
      pending: false,
      fired_at: firedAt,
      subscription_id: sub.id as string,
    };
  }

  // Schedule the delayed verify. Non-fatal: an Inngest send failure
  // shouldn't block the fire-side ack; the resolution-events stamp path
  // has its own fallback ('confirmed' at return time for the paths where
  // pending is false).
  try {
    await scheduleOrderNowVerify({
      workspace_id: workspaceId,
      subscription_id: sub.id as string,
      contract_id: contractId,
      fired_at: firedAt,
      is_internal: isInternal,
      resolution_event_id: ctx.resolution_event_id,
      ticket_id: ctx.ticket_id,
      customer_id: ctx.customer_id,
    });
  } catch (e) {
    console.warn(
      `[subscriptionOrderNowVerified] scheduleOrderNowVerify failed for contract=${contractId}:`,
      e instanceof Error ? e.message : e,
    );
  }

  return {
    success: true,
    summary: fired.summary,
    internal: isInternal,
    // Internal: renewal-attempt is our own pipeline — synchronous enough that
    // the ticket-executor can stamp at return time. Appstle: the vendor is
    // async and can decline; the resolution outcome MUST wait for the
    // scheduled verify.
    pending: !isInternal,
    fired_at: firedAt,
    subscription_id: sub.id as string,
  };
}

// ── Phase 2: decline → update-payment-method journey ──────────────
//
// When the async verify lands a `declined` verdict, hand the customer a
// self-service recovery link (`sendPaymentRecoveryEmail` — magic link →
// update card → migrate + reactivate + charge). This is the deterministic
// hand-off called out by the spec (no false "it shipped" message goes out;
// message-is-last).
//
// Guarded so we fire exactly once per (customer, fired_at) window even when
// dunning's billing-failure webhook ALSO delivers the recovery email:
//   - Missing customer_id → soft-skip (no target).
//   - A `dunning.recovery_email_sent` customer_events row for this customer
//     since fired_at → soft-skip (already delivered by dunning or a prior
//     verify attempt).
//
// The confirming-predicate guard is the read-then-write pattern:
//   1. Count customer_events since fired_at (fresh read).
//   2. Only insert the send if the count is zero.
// Race between two verify runs in the same window is still possible; the
// blast radius is a duplicate recovery email, which is idempotent from the
// customer's POV (same magic link, same recovery ticket tag).

/** Outcome of the decline → recovery dispatcher. */
export type RecoveryDispatchOutcome =
  | { sent: true; ticket_id?: string; message_id?: string }
  | { sent: false; skipped_reason: string; error?: string };

/** Overridable deps for testing the decline dispatcher without touching
 *  Resend / Supabase. Production callers omit the object and get the real
 *  implementations. */
export interface RecoveryDispatchDeps {
  /** Async predicate: has a recovery email already gone out to this
   *  customer since fired_at? Prod = COUNT on customer_events. */
  alreadySentSinceFiredAt: (input: {
    workspace_id: string;
    customer_id: string;
    fired_at: string;
  }) => Promise<boolean>;
  /** Delivery: fires the magic-link recovery email + tagged closed ticket. */
  sendRecovery: (
    workspace_id: string,
    customer_id: string,
    opts?: { subscriptionId?: string },
  ) => Promise<{ sent: boolean; ticketId?: string; messageId?: string; error?: string }>;
}

/**
 * Prod deps — wired to the real customer_events count + payment-recovery-email.
 * Extracted so tests can swap either side.
 */
export function defaultRecoveryDispatchDeps(): RecoveryDispatchDeps {
  return {
    alreadySentSinceFiredAt: async ({ workspace_id, customer_id, fired_at }) => {
      const admin = createAdminClient();
      const { count } = await admin
        .from("customer_events")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace_id)
        .eq("customer_id", customer_id)
        .eq("event_type", "dunning.recovery_email_sent")
        .gt("created_at", fired_at);
      return (count ?? 0) > 0;
    },
    sendRecovery: async (workspace_id, customer_id, opts) => {
      const { sendPaymentRecoveryEmail } = await import("@/lib/payment-recovery-email");
      return sendPaymentRecoveryEmail(workspace_id, customer_id, opts);
    },
  };
}

/**
 * Dispatcher: fire the update-payment-method recovery journey once for a
 * declined order-now verdict. Idempotent per (customer, fired_at) window.
 *
 * Extracted from the Inngest function so the guard predicate + delivery is
 * unit-testable — the Inngest fn is a thin adapter that wires event-data +
 * `defaultRecoveryDispatchDeps()`.
 */
export async function dispatchRecoveryOnDecline(
  input: {
    workspace_id: string;
    subscription_id: string;
    customer_id: string | null;
    fired_at: string;
  },
  deps: RecoveryDispatchDeps = defaultRecoveryDispatchDeps(),
): Promise<RecoveryDispatchOutcome> {
  if (!input.customer_id) {
    return { sent: false, skipped_reason: "no_customer_id" };
  }

  const already = await deps.alreadySentSinceFiredAt({
    workspace_id: input.workspace_id,
    customer_id: input.customer_id,
    fired_at: input.fired_at,
  });
  if (already) {
    return { sent: false, skipped_reason: "already_sent_since_fired_at" };
  }

  const res = await deps.sendRecovery(input.workspace_id, input.customer_id, {
    subscriptionId: input.subscription_id,
  });
  if (!res.sent) {
    return { sent: false, skipped_reason: "send_failed", error: res.error };
  }
  return { sent: true, ticket_id: res.ticketId, message_id: res.messageId };
}

// ── Phase 4: verified success → Sol confirms last ─────────────────
//
// A `paid` verdict from Phase 1 means the underlying payment landed — but the
// spec's message-is-last invariant requires MORE than that before the customer
// gets a confirmation reply. Sol's lightweight end-state pass verifies the
// order actually reflects the customer's intent (items present, non-zero
// total) and the subscription itself is HEALTHY (active, not paused/cancelled,
// with a succeeded last-payment). Only then does the ledger stamp
// `verified_outcome='confirmed'` — the signal the sibling
// [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]]
// send-guard (sol-outcome-claim-guard) reads to unblock the reply.
//
// If the end state fails (missing order, empty items, zero total, cancelled
// sub, non-succeeded payment status) the ledger stamps `drifted` with the
// failed checks recorded — Sol doesn't lie about the outcome, and the
// downstream completion gate escalates the ticket to a human.
//
// The predicate is pure; the reader wraps a single subscriptions read + the
// most-recent paid-order-since-fired_at read. The dispatcher composes them
// with an overridable deps object so tests pin the failure branches without
// spinning Supabase.

/** Evidence for the end-state verification — the paid order details + the
 *  subscription's health. */
export interface ConfirmationEndStateEvidence {
  /** True iff a paid order for this subscription created after `fired_at`
   *  was found. Should already be true by the time the dispatcher runs
   *  (Phase 1's verdict was `paid`) — but we re-read defensively because the
   *  order row is the source of truth for items/total. */
  paidOrderFound: boolean;
  /** Number of line items on the paid order. Must be > 0 — an empty-cart
   *  paid order is a bug we won't confirm. `null` when no order was found. */
  paidOrderLineItemsCount: number | null;
  /** `total_cents` on the paid order. Must be > 0 — a $0 order-now is not a
   *  charge the customer authorised. `null` when no order was found. */
  paidOrderTotalCents: number | null;
  /** Current subscriptions.status — must be `active` for a healthy confirm.
   *  A paused/cancelled sub after an order-now is a drift Sol can't just
   *  paper over with a "your order shipped" message. */
  subscriptionStatus: string | null;
  /** Current subscriptions.last_payment_status — must be `succeeded`. A
   *  `failed`/`skipped`/null status after a paid verdict means the account
   *  state hasn't caught up (or worse, the paid order is unrelated). */
  subscriptionLastPaymentStatus: string | null;
}

/** Verdict from the end-state predicate. `failed_checks` names each failed
 *  invariant so the ledger stamp / escalation reason is human-readable. */
export type ConfirmationEndStateVerdict =
  | { ok: true; failed_checks: [] }
  | { ok: false; failed_checks: string[] };

/**
 * Pure predicate mapping evidence → verdict. All checks are AND-ed — Sol only
 * confirms when EVERY end-state invariant holds. Extracted so tests can pin
 * the decision table without spinning Supabase:
 *
 * - `no_paid_order`: verdict was `paid` but the reader couldn't find the order
 *   row (race / subscription-id mismatch). Confirming would be a false claim.
 * - `paid_order_empty_line_items`: order exists but has zero line items.
 * - `paid_order_zero_total`: order exists but total_cents ≤ 0.
 * - `subscription_not_active`: sub is paused/cancelled — end state doesn't
 *   match "your subscription order is on the way".
 * - `subscription_payment_status_not_succeeded`: sub's last_payment_status
 *   drifted (e.g., a billing-failure webhook landed after the paid signal).
 */
export function computeConfirmationEndState(
  evidence: ConfirmationEndStateEvidence,
): ConfirmationEndStateVerdict {
  const failed: string[] = [];
  if (!evidence.paidOrderFound) failed.push("no_paid_order");
  if (
    evidence.paidOrderLineItemsCount !== null
    && evidence.paidOrderLineItemsCount <= 0
  ) failed.push("paid_order_empty_line_items");
  if (
    evidence.paidOrderTotalCents !== null
    && evidence.paidOrderTotalCents <= 0
  ) failed.push("paid_order_zero_total");
  if (evidence.subscriptionStatus !== "active") failed.push("subscription_not_active");
  if (evidence.subscriptionLastPaymentStatus !== "succeeded") {
    failed.push("subscription_payment_status_not_succeeded");
  }
  return failed.length === 0
    ? { ok: true, failed_checks: [] }
    : { ok: false, failed_checks: failed };
}

/**
 * Read the end-state evidence (paid order + subscription health) and compute
 * the verdict. Kept read-only so the dispatcher can call it inside a
 * `step.run` without side-effects.
 */
export async function verifyConfirmationEndState(
  admin: ReturnType<typeof createAdminClient>,
  opts: {
    workspace_id: string;
    subscription_id: string;
    fired_at: string;
  },
): Promise<{ verdict: ConfirmationEndStateVerdict; evidence: ConfirmationEndStateEvidence }> {
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, status, last_payment_status")
    .eq("workspace_id", opts.workspace_id)
    .eq("id", opts.subscription_id)
    .maybeSingle();

  const { data: order } = await admin
    .from("orders")
    .select("id, line_items, total_cents")
    .eq("workspace_id", opts.workspace_id)
    .eq("subscription_id", opts.subscription_id)
    .eq("financial_status", "paid")
    .gt("created_at", opts.fired_at)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lineItems = Array.isArray(order?.line_items)
    ? (order!.line_items as unknown[]).length
    : null;

  const evidence: ConfirmationEndStateEvidence = {
    paidOrderFound: Boolean(order),
    paidOrderLineItemsCount: order ? (lineItems ?? 0) : null,
    paidOrderTotalCents: order ? ((order.total_cents as number | null) ?? 0) : null,
    subscriptionStatus: (sub?.status as string | null) ?? null,
    subscriptionLastPaymentStatus: (sub?.last_payment_status as string | null) ?? null,
  };

  return { verdict: computeConfirmationEndState(evidence), evidence };
}

// ── Phase 3: journey complete → migrate → deterministic order-now retry ──
//
// When the update-payment-method journey completes, `vaultAndMigratePaymentMethod`
// vaults the card and migrates the customer's Appstle subs onto internal (see
// [[../libraries/vault-and-migrate-payment-method]]). At that point the sub is
// INTERNAL — no Appstle latency, no vendor decline path — so we can retry the
// original order-now DETERMINISTICALLY in plain Node (no box / Sol session).
//
// This lives on the commerce library (not journey-outcomes / dunning) so the
// same dispatcher covers every migrate-on-recovery caller: the mini-site
// journey submit path AND the portal's failed-payment magic-link flow (both
// go through `vaultAndMigratePaymentMethod`).
//
// Idempotency (spec: "the retry can't double-charge"):
//   1. Guard predicate: skip if a `commerce.order_now.retry_after_migrate`
//      customer_events row exists for this subscription since `migrated_at`.
//      One retry per (subscription, migrate) window.
//   2. On successful fire, log the same customer_events row — so a re-drive of
//      the same migrate call finds the guard tripped and soft-skips.
//   3. `subscriptionOrderNowVerified` itself is idempotent at the Braintree
//      renewal-attempt layer (Inngest dedupes on the event); the guard covers
//      the outer caller pattern.
//
// The dispatcher is separated from the reader so tests can pin the guard +
// fire behavior without spinning Supabase / Inngest.

/** Outcome of the confirmation dispatcher — a typed report the Inngest fn
 *  writes into the terminal payload + uses to pick between `confirmed` and
 *  `drifted` for the ledger stamp. */
export type ConfirmationDispatchOutcome =
  | { confirmed: true; evidence: ConfirmationEndStateEvidence }
  | { confirmed: false; failed_checks: string[]; evidence: ConfirmationEndStateEvidence };

/** Overridable deps for testing the confirmation dispatcher without touching
 *  Supabase. Production callers omit the object and get the real reader. */
export interface ConfirmationDispatchDeps {
  verifyEndState: (input: {
    workspace_id: string;
    subscription_id: string;
    fired_at: string;
  }) => Promise<{ verdict: ConfirmationEndStateVerdict; evidence: ConfirmationEndStateEvidence }>;
}

/** Prod deps — wired to the real `verifyConfirmationEndState` reader. */
export function defaultConfirmationDispatchDeps(): ConfirmationDispatchDeps {
  return {
    verifyEndState: async (input) => {
      const admin = createAdminClient();
      return verifyConfirmationEndState(admin, input);
    },
  };
}

/**
 * Dispatcher: run Sol's lightweight end-state pass on a paid verdict. Returns
 * a typed outcome the Inngest fn uses to decide `confirmed` vs `drifted` on
 * the ledger stamp. Sol never lies — a failed end-state check means the
 * customer confirmation is BLOCKED (message-is-last), the ledger records
 * `drifted` with the failed checks, and the completion gate can escalate.
 */
export async function dispatchConfirmationOnVerified(
  input: {
    workspace_id: string;
    subscription_id: string;
    fired_at: string;
  },
  deps: ConfirmationDispatchDeps = defaultConfirmationDispatchDeps(),
): Promise<ConfirmationDispatchOutcome> {
  const { verdict, evidence } = await deps.verifyEndState(input);
  if (verdict.ok) {
    return { confirmed: true, evidence };
  }
  return { confirmed: false, failed_checks: verdict.failed_checks, evidence };
}

// ── Phase 3: order-now retry after migrate ─────────────────────────

/** Outcome of the retry dispatcher — the caller (vaultAndMigratePaymentMethod)
 *  aggregates one per migrated sub. */
export type OrderNowRetryOutcome =
  | { retried: true; contract_id: string; internal: boolean; fired_at: string; result: OrderNowVerifiedResult }
  | { retried: false; contract_id: string; skipped_reason: string; error?: string };

/** Overridable deps for testing the retry dispatcher without touching
 *  Supabase / Inngest. Production callers omit the object and get the real
 *  implementations. */
export interface OrderNowRetryDeps {
  /** Async predicate: has this subscription already been retried after the
   *  given `migrated_at` cutoff? Prod = COUNT on customer_events. */
  alreadyRetriedSinceMigrated: (input: {
    workspace_id: string;
    subscription_id: string;
    migrated_at: string;
  }) => Promise<boolean>;
  /** Fire: the deterministic order-now retry. On the migrated (internal) sub
   *  this fires the Braintree renewal-attempt event via subscriptionOrderNow
   *  AND schedules the async verify. Returns the standard verified-result. */
  fireVerifiedOrderNow: (
    workspace_id: string,
    contract_id: string,
    ctx: OrderNowVerifyContext,
  ) => Promise<OrderNowVerifiedResult>;
  /** Log: record the retry so the idempotency guard on a re-drive finds it. */
  logRetryEvent: (input: {
    workspace_id: string;
    customer_id: string;
    subscription_id: string;
    contract_id: string;
    migrated_at: string;
  }) => Promise<void>;
}

/**
 * Prod deps — wired to the real customer_events count + subscriptionOrderNowVerified
 * fire + logCustomerEvent write. Extracted so tests can swap any side.
 */
export function defaultOrderNowRetryDeps(): OrderNowRetryDeps {
  return {
    alreadyRetriedSinceMigrated: async ({ workspace_id, subscription_id, migrated_at }) => {
      const admin = createAdminClient();
      const { count } = await admin
        .from("customer_events")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace_id)
        .eq("event_type", "commerce.order_now.retry_after_migrate")
        .eq("properties->>subscription_id", subscription_id)
        .gte("created_at", migrated_at);
      return (count ?? 0) > 0;
    },
    fireVerifiedOrderNow: async (workspace_id, contract_id, ctx) => {
      return subscriptionOrderNowVerified(workspace_id, contract_id, ctx);
    },
    logRetryEvent: async ({ workspace_id, customer_id, subscription_id, contract_id, migrated_at }) => {
      const { logCustomerEvent } = await import("@/lib/customer-events");
      await logCustomerEvent({
        workspaceId: workspace_id,
        customerId: customer_id,
        eventType: "commerce.order_now.retry_after_migrate",
        source: "payment_recovery",
        summary: `Fired deterministic order-now retry on migrated internal sub ${contract_id}.`,
        properties: { subscription_id, contract_id, migrated_at },
      });
    },
  };
}

/**
 * Dispatcher: fire the deterministic order-now retry on a freshly-migrated
 * internal sub — Phase 3 of the spec. Guards on the retry-event idempotency
 * marker so a re-drive of vaultAndMigratePaymentMethod doesn't double-charge.
 * No box / Sol session — internal sub = immediate Braintree renewal via
 * subscriptionOrderNow, verified end-state via the same async verify pipeline
 * as any other order-now (Phase 1 → Phase 4).
 */
export async function dispatchOrderNowRetryOnMigrate(
  input: {
    workspace_id: string;
    customer_id: string;
    subscription_id: string;
    /** Post-migration `subscriptions.shopify_contract_id` — the internal-*
     *  id the renewal pipeline reads. */
    contract_id: string;
    /** Cutoff for the idempotency guard. Callers pass the migration's
     *  `subscription.migrated` timestamp (or "now" for a fresh migrate). */
    migrated_at: string;
    /** For threading through to the verify's decline-branch recovery journey
     *  (Phase 2) — the customer id the recovery email would target. */
    ticket_id?: string;
  },
  deps: OrderNowRetryDeps = defaultOrderNowRetryDeps(),
): Promise<OrderNowRetryOutcome> {
  const already = await deps.alreadyRetriedSinceMigrated({
    workspace_id: input.workspace_id,
    subscription_id: input.subscription_id,
    migrated_at: input.migrated_at,
  });
  if (already) {
    return {
      retried: false,
      contract_id: input.contract_id,
      skipped_reason: "already_retried_since_migrated",
    };
  }

  const result = await deps.fireVerifiedOrderNow(input.workspace_id, input.contract_id, {
    customer_id: input.customer_id,
    ticket_id: input.ticket_id,
  });
  if (!result.success) {
    return {
      retried: false,
      contract_id: input.contract_id,
      skipped_reason: "fire_failed",
      error: result.error,
    };
  }

  // Log after a successful fire so a re-drive finds the guard tripped.
  try {
    await deps.logRetryEvent({
      workspace_id: input.workspace_id,
      customer_id: input.customer_id,
      subscription_id: input.subscription_id,
      contract_id: input.contract_id,
      migrated_at: input.migrated_at,
    });
  } catch {
    // Non-fatal: the fire has landed; a missing log still lets the customer
    // see the recovered order. The next re-drive's guard just won't trip.
  }

  return {
    retried: true,
    contract_id: input.contract_id,
    internal: result.internal,
    fired_at: result.fired_at,
    result,
  };
}
