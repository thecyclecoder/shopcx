/**
 * Internal-subscription dunning — failed-payment recovery for is_internal subs.
 *
 * The legacy dunning system ([[dunning]]) is built entirely around Appstle webhooks
 * + Shopify card rotation, which don't exist for internal (Braintree-billed) subs.
 * This module is the internal path: a failed internal renewal enters dunning here,
 * retries on the payday schedule by re-firing the internal renewal (the daily
 * renewal cron IS the retry engine — we just move next_billing_date to the next
 * payday), emails a recovery magic-link on the first terminal error (else after
 * retries exhaust), and writes customer_events so the timeline + AI see it.
 *
 * Settled decisions (docs/brain/specs/internal-dunning.md):
 *   - Retry cadence: dunning payday schedule, re-firing the internal renewal.
 *   - Email: after first TERMINAL error; else after payday retries exhaust.
 *   - Ticket: attach to the most-recent open ticket (tag dunning:active).
 *   - Exhaustion: CANCEL the sub; recovery reactivates it (cancelled-by-dunning).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logCustomerEvent } from "@/lib/customer-events";
import {
  getDunningSettings,
  getActiveDunningCycle,
  createDunningCycle,
  updateDunningCycle,
  logPaymentFailure,
  getNextPaydayDates,
  dunningInternalNote,
  postDunningNoteOnTicket,
  tagOpenTickets,
} from "@/lib/dunning";

/** Max payday retries before we give up and cancel. */
const MAX_PAYDAY_RETRIES = 4;

/**
 * Braintree processor-response codes that are TERMINAL (hard decline — the card
 * will never work: expired, closed, invalid, stolen). Soft declines (insufficient
 * funds 2001, processor-unavailable, etc.) are retried silently on payday first.
 */
const BRAINTREE_TERMINAL = new Set([
  "2004", // Expired Card
  "2005", // Invalid Credit Card Number
  "2007", // No Account
  "2008", // Card Account Length Error
  "2009", // No Such Issuer
  "2010", // Card Issuer Declined CVV
  "2012", // Voice Authorization Required
  "2015", // Transaction Not Allowed
  "2044", // Declined - Call Issuer
  "2046", // Declined
  "2047", // Call Issuer. Pick Up Card.
  "2057", // Issuer or Cardholder has put a restriction on the card
]);

function isBraintreeTerminal(code: string | null | undefined): boolean {
  return code ? BRAINTREE_TERMINAL.has(String(code)) : false;
}

export interface InternalDunningInput {
  workspace_id: string;
  subscription_id: string;
  customer_id: string | null;
  internal_contract_id: string; // the internal-* id (stored in dunning_cycles.shopify_contract_id)
  error_code: string | null;    // Braintree processor response code
  error_message: string | null;
  amount_cents?: number;
}

/**
 * Handle a failed internal renewal. Creates/advances the dunning cycle, logs the
 * failure + customer_events, emails on terminal error, schedules the next payday
 * retry, and cancels on exhaustion. Returns a status for the caller's logs.
 */
export async function handleInternalDunningFailure(input: InternalDunningInput): Promise<{ status: string; cycle_id?: string }> {
  const { workspace_id, subscription_id, customer_id, internal_contract_id, error_code, error_message } = input;
  const admin = createAdminClient();

  const settings = await getDunningSettings(workspace_id);
  if (!settings?.dunning_enabled) return { status: "dunning_disabled" };

  // Load or open the cycle (keyed on subscription_id via shopify_contract_id = internal-*).
  const existing = await getActiveDunningCycle(workspace_id, internal_contract_id);
  const isNew = !existing;
  const cycleId = existing
    ? existing.id
    : (await createDunningCycle(workspace_id, internal_contract_id, subscription_id, customer_id, null)).id;

  // Count prior failed attempts on this cycle to decide retry vs exhaust.
  const { count: priorFails } = await admin
    .from("payment_failures")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace_id)
    .eq("subscription_id", subscription_id)
    .eq("succeeded", false)
    .gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString());
  const attemptNumber = (priorFails || 0) + 1;

  await logPaymentFailure({
    workspaceId: workspace_id,
    customerId: customer_id,
    subscriptionId: subscription_id,
    shopifyContractId: internal_contract_id,
    billingAttemptId: null,
    errorCode: error_code,
    errorMessage: error_message,
    attemptNumber,
    attemptType: isNew ? "initial" : "payday_retry",
    succeeded: false,
  });

  await logCustomerEvent({
    workspaceId: workspace_id,
    customerId: customer_id,
    eventType: "subscription.payment_failed",
    source: "internal_dunning",
    summary: `Renewal payment failed (attempt ${attemptNumber})${error_message ? ` — ${error_message}` : ""}`,
    properties: { subscription_id, internal_contract_id, error_code, error_message, attempt: attemptNumber, cycle_id: cycleId },
  });

  if (isNew) {
    await tagOpenTickets(workspace_id, customer_id, "dunning:active");
    await postDunningNoteOnTicket(workspace_id, customer_id, dunningInternalNote(
      `Internal renewal payment failed (${error_code || "decline"}). Started dunning — will retry on the payday schedule.`,
    ));
  }

  const terminal = isBraintreeTerminal(error_code);
  const retriesEnabled = settings.dunning_payday_retry_enabled;
  const exhausted = !retriesEnabled || attemptNumber > MAX_PAYDAY_RETRIES;

  if (exhausted) {
    await exhaustInternalDunning(workspace_id, subscription_id, customer_id, internal_contract_id, cycleId);
    return { status: "exhausted", cycle_id: cycleId };
  }

  // Schedule the next payday retry: move next_billing_date to the next payday so
  // the daily internal-renewal cron re-attempts then. (The renewal advances it on
  // success; a failure re-enters this handler.)
  const nextPayday = getNextPaydayDates(new Date(), 1)[0] || new Date(Date.now() + 7 * 86400000);
  await admin.from("subscriptions")
    .update({ next_billing_date: nextPayday.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", subscription_id);
  await updateDunningCycle(cycleId, { status: "retrying", next_retry_at: nextPayday.toISOString() });

  // Email on the first TERMINAL error (the card will never work — don't make the
  // customer wait through silent retries). Soft declines wait until exhaustion.
  if (terminal) {
    await sendInternalRecoveryEmail(workspace_id, customer_id, cycleId);
  }

  return { status: terminal ? "terminal_emailed" : "retrying", cycle_id: cycleId };
}

/** Cancel the sub (recovery will reactivate it) + email if not already sent. */
async function exhaustInternalDunning(
  workspaceId: string, subscriptionId: string, customerId: string | null, internalContractId: string, cycleId: string,
): Promise<void> {
  const admin = createAdminClient();
  await admin.from("subscriptions")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  await updateDunningCycle(cycleId, { status: "exhausted", paused_at: new Date().toISOString() });
  await tagOpenTickets(workspaceId, customerId, "dunning:cancelled");
  await logCustomerEvent({
    workspaceId, customerId,
    eventType: "subscription.cancelled",
    source: "internal_dunning",
    summary: "Subscription cancelled after payment retries were exhausted — will reactivate when the customer updates their card.",
    properties: { subscription_id: subscriptionId, internal_contract_id: internalContractId, reason: "dunning_exhausted", cycle_id: cycleId },
  });
  await sendInternalRecoveryEmail(workspaceId, customerId, cycleId);
}

/** Email the recovery magic-link + record it on the cycle. Attaches to the most-recent ticket. */
async function sendInternalRecoveryEmail(workspaceId: string, customerId: string | null, cycleId: string): Promise<void> {
  if (!customerId) return;
  const admin = createAdminClient();
  // Don't double-send.
  const { data: cyc } = await admin.from("dunning_cycles").select("payment_update_sent").eq("id", cycleId).maybeSingle();
  if (cyc?.payment_update_sent) return;

  const { data: customer } = await admin.from("customers").select("email, first_name, shopify_customer_id").eq("id", customerId).single();
  const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
  if (!customer?.email || !ws?.name) return;

  const { generatePaymentRecoveryLink } = await import("@/lib/magic-link");
  const link = await generatePaymentRecoveryLink(customerId, customer.shopify_customer_id || "", customer.email, workspaceId);
  const btn = `<a href="${link}" style="display:inline-block;padding:13px 26px;background:#1f5e3a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Update my payment method</a>`;
  const body = `<p>Hi ${customer.first_name || "there"}, we tried to process your subscription renewal but your card was declined.</p>
<p>It's an easy fix — just tap the button below to update your payment method, and we'll take care of the rest.</p>
<p>${btn}</p>
<p>The ${ws.name} Team</p>`;

  try {
    const { sendTicketReply } = await import("@/lib/email");
    // Attach to the most-recent open/pending ticket so a reply threads in.
    const { data: ticket } = await admin.from("tickets")
      .select("id, subject, email_message_id")
      .eq("workspace_id", workspaceId).eq("customer_id", customerId)
      .in("status", ["open", "pending"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (ticket) {
      await admin.from("ticket_messages").insert({ ticket_id: ticket.id, direction: "outbound", visibility: "external", author_type: "ai", body, sent_at: new Date().toISOString() });
    }
    await sendTicketReply({
      workspaceId, toEmail: customer.email,
      subject: ticket?.subject ? `Re: ${ticket.subject}` : `Action needed: update your payment method`,
      body, inReplyTo: ticket?.email_message_id || null, agentName: ws.name, workspaceName: ws.name,
    });
    await updateDunningCycle(cycleId, { payment_update_sent: true, payment_update_sent_at: new Date().toISOString() });
    await logCustomerEvent({
      workspaceId, customerId, eventType: "dunning.recovery_email_sent", source: "internal_dunning",
      summary: "Sent a payment-recovery link.", properties: { cycle_id: cycleId },
    });
  } catch (e) {
    console.error("[internal-dunning] recovery email failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Close the dunning cycle when an internal renewal succeeds. Called from the
 * renewal success path. Marks recovered + writes a timeline event.
 */
export async function closeInternalDunningOnSuccess(workspaceId: string, subscriptionId: string, internalContractId: string, customerId: string | null): Promise<void> {
  const cycle = await getActiveDunningCycle(workspaceId, internalContractId);
  if (!cycle) return;
  await updateDunningCycle(cycle.id, { status: "recovered", recovered_at: new Date().toISOString() });
  await tagOpenTickets(workspaceId, customerId, "dunning:recovered");
  await logCustomerEvent({
    workspaceId, customerId, eventType: "payment.recovered", source: "internal_dunning",
    summary: "Payment recovered — dunning cycle closed.", properties: { subscription_id: subscriptionId, internal_contract_id: internalContractId, cycle_id: cycle.id },
  });
}

/**
 * Reactivate subs cancelled BY DUNNING for a customer's link group (called from
 * the payment-recovery flow). A sub is "cancelled by dunning" if it's cancelled
 * AND has an exhausted dunning cycle — NOT a voluntary cancel. Returns the count.
 */
export async function reactivateDunningCancelledSubs(workspaceId: string, customerIds: string[]): Promise<number> {
  const admin = createAdminClient();
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, billing_interval, billing_interval_count")
    .eq("workspace_id", workspaceId).in("customer_id", customerIds)
    .eq("is_internal", true).eq("status", "cancelled");
  if (!subs?.length) return 0;

  let reactivated = 0;
  for (const sub of subs) {
    const { data: cyc } = await admin.from("dunning_cycles")
      .select("id").eq("workspace_id", workspaceId).eq("subscription_id", sub.id as string)
      .in("status", ["exhausted", "cancelled"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!cyc) continue; // not a dunning cancel — leave it

    const interval = String(sub.billing_interval || "month").toLowerCase();
    const count = Number(sub.billing_interval_count || 1);
    const next = new Date();
    if (interval === "day") next.setUTCDate(next.getUTCDate() + count);
    else if (interval === "week") next.setUTCDate(next.getUTCDate() + count * 7);
    else if (interval === "year") next.setUTCFullYear(next.getUTCFullYear() + count);
    else next.setUTCMonth(next.getUTCMonth() + count);
    next.setUTCHours(8, 0, 0, 0);

    await admin.from("subscriptions")
      .update({ status: "active", next_billing_date: next.toISOString(), updated_at: new Date().toISOString() })
      .eq("id", sub.id as string);
    await updateDunningCycle(cyc.id as string, { status: "recovered", recovered_at: new Date().toISOString() });
    await logCustomerEvent({
      workspaceId, customerId: customerIds[0], eventType: "subscription.reactivated", source: "internal_dunning",
      summary: "Subscription reactivated after the customer updated their card.", properties: { subscription_id: sub.id },
    });
    reactivated++;
  }
  return reactivated;
}
