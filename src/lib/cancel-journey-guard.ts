/**
 * Cancel-journey guard — pure predicates + a thin DB helper for the
 * "saved_remedy must not trap a re-requesting customer" fix.
 *
 * Ticket 6c12a925 surfaced the pattern: a customer completes the cancel
 * journey into a `saved_remedy` (accepted a pause / coupon / skip),
 * hears "we've updated your subscription", then IMMEDIATELY re-asks
 * "cancel my subscription" — but every downstream path treats the
 * accepted save as authoritative. The next cancel journey re-launched
 * from the orchestrator re-presents the same remedy step, and after
 * three inbound-in-a-row [[no-progress-guard]] escalates to human
 * review with no in-leash tool ([[action-executor]] `directActionHandlers`
 * exposes no cancel action). The customer is trapped.
 *
 * Structural fix: when we detect a completed saved_remedy on the same
 * ticket, we route the next cancel-journey delivery STRAIGHT to its
 * decline-offer / confirm-cancel terminal (skip subscription→reason→
 * remedies). Cancellation still completes only via the customer's own
 * confirm button on the mini-site — we just get them to that button
 * without re-presenting the offer they've already rejected in words.
 *
 * The predicate is also used by [[no-progress-guard]] to re-send a
 * fresh cancel journey when a routine-cancel loop trips the circuit,
 * instead of dead-ending at human review.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Loose free-text detector for a cancel-my-subscription-style message.
 * Pure — no I/O — kept exported for the unit test. Aligned with the
 * DB-driven `journey_definitions.match_patterns` for `cancel_subscription`
 * (see [[../journeys/cancel]]) but deliberately narrower: only fires on
 * an ACTION verb the customer is asking us to do, not on a mention of
 * cancellation in a different context (e.g. "shipping cancelled by the
 * carrier — where's my refund?"). Common misspellings mirrored from the
 * intent's canonical pattern list.
 */
export function looksLikeCancelIntent(body: string | null | undefined): boolean {
  const text = (body || "").toLowerCase();
  if (!text) return false;
  // Strip HTML so an email body like `<p>cancel my subscription</p>` matches.
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return false;

  // Negative context: don't fire on carrier / order-cancellation reports.
  if (/\b(cancell?ed|cancellation)\s+by\s+(the\s+)?(carrier|shipper|shipping|ups|usps|fedex|dhl)\b/.test(plain)) {
    return false;
  }

  const CANCEL_VERBS = [
    "cancel my subscription",
    "cancel my sub",
    "cancel my account",
    "cancel the subscription",
    "cancel subscription",
    "cancel my order",   // ambiguous with returns, but the caller has already scoped this to a ticket with an active subscription
    "cancel it",
    "cancel that",
    "just cancel",
    "please cancel",
    "want to cancel",
    "wanna cancel",
    "need to cancel",
    "stop my subscription",
    "stop the subscription",
    "stop charging me",
    "stop sending",
    "stop deliveries",
    "end my subscription",
    "end subscription",
    "close my account",
    "unsubscribe me",
    // common misspellings — mirrors the DB match_patterns for cancel_subscription
    "cancle",
    "cancell",
    "canel",
  ];
  return CANCEL_VERBS.some((v) => plain.includes(v));
}

/**
 * Detect whether this ticket already has a completed cancel-journey
 * session whose outcome was a SAVED remedy (customer accepted a pause /
 * coupon / skip / frequency change). Fresh cancel-journey deliveries
 * on such a ticket must skip the remedy step and route straight to the
 * confirm-cancel terminal — a save the customer has explicitly rejected
 * in the immediately-following inbound(s) must not be re-presented.
 *
 * Scoped by ticket_id (not customer_id) — the trap is within the SAME
 * support ticket. Uses `outcome ilike 'saved_%'` so `saved_remedy`,
 * `saved_changed_mind`, and any future `saved_*` outcome all count.
 *
 * Returns `hasSavedRemedy=false` for a ticket with no completed cancel
 * journey OR whose only completed session came out `cancelled` (that
 * outcome is terminal — the ticket has already closed).
 */
export async function hasRecentSavedRemedy(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<{ hasSavedRemedy: boolean; sessionId: string | null; completedAt: string | null }> {
  const { data } = await admin
    .from("journey_sessions")
    .select("id, outcome, completed_at")
    .eq("workspace_id", workspaceId)
    .eq("ticket_id", ticketId)
    .eq("status", "completed")
    .ilike("outcome", "saved_%")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { hasSavedRemedy: false, sessionId: null, completedAt: null };
  const row = data as { id: string; outcome: string | null; completed_at: string | null };
  return {
    hasSavedRemedy: true,
    sessionId: row.id,
    completedAt: row.completed_at,
  };
}

/**
 * Cancel-intent aliases that should trigger the routine-cancel re-send
 * path in [[no-progress-guard]]. Kept aligned with the trigger_intent
 * strings the cancel journey_definitions row uses today.
 */
export const CANCEL_TRIGGER_INTENTS = new Set([
  "cancel_subscription",
  "cancel",
  "cancellation",
]);

export function isCancelTriggerIntent(intent: string | null | undefined): boolean {
  if (!intent) return false;
  return CANCEL_TRIGGER_INTENTS.has(intent.toLowerCase());
}
