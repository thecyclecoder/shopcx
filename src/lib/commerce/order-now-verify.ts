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
