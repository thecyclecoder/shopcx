/**
 * Payment-recovery email — the "please update your payment method" email,
 * upgraded from a static portal URL to a personalized magic-link flow.
 *
 * Sends a [[magic-link]] recovery link (auto-login → straight to the
 * update-payment-method form, which migrates the sub to internal + pins
 * the new card + charges now). Also CREATES a tagged, CLOSED ticket and
 * sets the email's Reply-To to the inbound address, so if the customer
 * replies with a question it threads into that ticket and reaches the
 * team. Used by both the legacy Appstle dunning path and the internal
 * dunning path so every recovery email is identical.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getResendClient } from "@/lib/email";
import { generatePaymentRecoveryLink } from "@/lib/magic-link";
import { logCustomerEvent } from "@/lib/customer-events";
import { randomUUID } from "crypto";

/** Where replies route — an inbound-parsed address that lands back on the ticket. */
export const RECOVERY_REPLY_TO = process.env.DUNNING_INBOUND_REPLY_TO || "inbound@updates.superfoodscompany.com";

/** Tag every recovery ticket so a saved view can collect them. */
export const RECOVERY_TICKET_TAG = "payment-recovery";

export interface RecoveryEmailResult {
  sent: boolean;
  ticketId?: string;
  link?: string;
  messageId?: string;
  error?: string;
}

/**
 * Send the magic-link recovery email + create the tagged closed ticket.
 * Best-effort — returns an error rather than throwing so the dunning
 * pipeline never breaks on an email failure.
 */
export async function sendPaymentRecoveryEmail(
  workspaceId: string,
  customerId: string,
): Promise<RecoveryEmailResult> {
  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name, shopify_customer_id")
    .eq("id", customerId)
    .maybeSingle();
  const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
  if (!customer?.email) return { sent: false, error: "no_customer_email" };
  if (!ws?.name) return { sent: false, error: "no_workspace" };

  const client = await getResendClient(workspaceId, customer.email);
  if (!client) return { sent: false, error: "resend_not_configured" };

  const link = await generatePaymentRecoveryLink(customerId, customer.shopify_customer_id || "", customer.email, workspaceId);
  const greeting = customer.first_name ? `Hi ${customer.first_name},` : "Hi there,";
  const subject = `Action needed: update your payment method — ${ws.name}`;

  // Deterministic Message-ID so the customer's reply threads onto the
  // ticket we create here (the inbound webhook also has a subject + same-
  // customer fallback, so threading survives even if a provider rewrites it).
  const messageId = `<recovery-${randomUUID()}@updates.superfoodscompany.com>`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #18181b; font-size: 20px; margin-bottom: 8px;">${greeting}</h2>
      <p style="color: #52525b; font-size: 14px; line-height: 1.6;">
        Your recent payment didn't go through. To keep your subscription active and avoid missing your next order, tap below to update your payment method — it takes about 30 seconds and we'll take care of the rest.
      </p>
      <div style="text-align: center; margin-top: 32px;">
        <a href="${link}" style="display: inline-block; padding: 14px 32px; background: #1f5e3a; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-size: 15px; font-weight: 600;">
          Update my payment method
        </a>
      </div>
      <p style="color: #a1a1aa; font-size: 12px; margin-top: 32px; text-align: center;">
        Questions or trouble updating? Just reply to this email and we'll help you out.
      </p>
    </div>`;

  const { data: sendRes, error: sendErr } = await client.resend.emails.send({
    from: `${ws.name} <support@${client.domain}>`,
    to: customer.email,
    replyTo: RECOVERY_REPLY_TO,
    subject,
    html,
    headers: { "Message-ID": messageId },
  });
  if (sendErr) return { sent: false, error: sendErr.message };

  // Create the tagged, CLOSED ticket so a reply threads in (via the
  // Message-ID, or the webhook's subject + same-customer fallback).
  let ticketId: string | undefined;
  try {
    const { data: ticket } = await admin
      .from("tickets")
      .insert({
        workspace_id: workspaceId,
        customer_id: customerId,
        channel: "email",
        status: "closed",
        subject,
        tags: [RECOVERY_TICKET_TAG],
        email_message_id: messageId,
        received_at_email: RECOVERY_REPLY_TO,
      })
      .select("id")
      .single();
    ticketId = ticket?.id as string | undefined;
    if (ticketId) {
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId,
        direction: "outbound",
        visibility: "external",
        author_type: "ai",
        body: html,
        email_message_id: messageId,
        sent_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error("[payment-recovery-email] ticket create failed (non-fatal):", e instanceof Error ? e.message : e);
  }

  await logCustomerEvent({
    workspaceId,
    customerId,
    eventType: "dunning.recovery_email_sent",
    source: "dunning",
    summary: "Sent a payment-recovery link (magic link → update card).",
    properties: { ticket_id: ticketId, message_id: messageId },
  });

  return { sent: true, ticketId, link, messageId: sendRes?.id };
}
