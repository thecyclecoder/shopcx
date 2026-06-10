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
  opts?: { subscriptionId?: string },
): Promise<RecoveryEmailResult> {
  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("email, first_name, shopify_customer_id")
    .eq("id", customerId)
    .maybeSingle();
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, support_email, storefront_logo_url, storefront_primary_color")
    .eq("id", workspaceId)
    .single();
  if (!customer?.email) return { sent: false, error: "no_customer_email" };
  if (!ws?.name) return { sent: false, error: "no_workspace" };

  const client = await getResendClient(workspaceId, customer.email);
  if (!client) return { sent: false, error: "resend_not_configured" };

  const link = await generatePaymentRecoveryLink(customerId, customer.shopify_customer_id || "", customer.email, workspaceId);
  const subject = `Action needed: update your payment method — ${ws.name}`;
  const supportEmail = ws.support_email || `support@${client.domain}`;
  const subsBlock = await renderSubscriptionDetails(admin, workspaceId, customerId, opts?.subscriptionId);

  // Deterministic Message-ID so the customer's reply threads onto the
  // ticket we create here (the inbound webhook also has a subject + same-
  // customer fallback, so threading survives even if a provider rewrites it).
  const messageId = `<recovery-${randomUUID()}@updates.superfoodscompany.com>`;

  const html = buildRecoveryEmailHtml({
    workspaceName: ws.name,
    logoUrl: ws.storefront_logo_url || null,
    primaryColor: ws.storefront_primary_color || "#055c3f",
    firstName: customer.first_name || null,
    link,
    supportEmail,
    subscriptionsHtml: subsBlock,
  });

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

/**
 * Render the customer's subscription(s) as a details card for the email —
 * shows what they're about to lose, which both motivates the update AND
 * proves the email is legitimate (a phisher wouldn't know their order).
 * Uses the given subscriptionId, else the link group's active/paused subs.
 */
async function renderSubscriptionDetails(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  customerId: string,
  subscriptionId?: string,
): Promise<string> {
  type SubRow = { id: string; items: unknown; billing_interval: string | null; billing_interval_count: number | null; next_billing_date: string | null; status: string };
  let subs: SubRow[] = [];
  try {
    if (subscriptionId) {
      const { data } = await admin
        .from("subscriptions")
        .select("id, items, billing_interval, billing_interval_count, next_billing_date, status")
        .eq("id", subscriptionId).maybeSingle();
      if (data) subs = [data as SubRow];
    } else {
      const { linkGroupIds } = await import("@/lib/customer-links");
      const groupIds = await linkGroupIds(admin, workspaceId, customerId);
      const { data } = await admin
        .from("subscriptions")
        .select("id, items, billing_interval, billing_interval_count, next_billing_date, status")
        .eq("workspace_id", workspaceId).in("customer_id", groupIds)
        .in("status", ["active", "paused", "cancelled"])
        .order("updated_at", { ascending: false }).limit(3);
      subs = (data as SubRow[]) || [];
    }
  } catch {
    return "";
  }
  if (subs.length === 0) return "";

  const rows = subs.map((sub) => {
    const items = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
    const lines = items
      .filter((i) => !String(i.title || "").toLowerCase().includes("shipping protection"))
      .map((i) => {
        const qty = Number(i.quantity || 1);
        const title = String(i.title || "Item");
        return `<tr><td style="padding:2px 0;color:#3f3f46;font-size:14px;">${qty} × ${escapeHtml(title)}</td></tr>`;
      })
      .join("");
    const count = Number(sub.billing_interval_count || 1);
    const interval = String(sub.billing_interval || "month").toLowerCase();
    const freq = `every ${count > 1 ? `${count} ` : ""}${interval}${count > 1 ? "s" : ""}`;
    const next = sub.next_billing_date
      ? new Date(sub.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null;
    return `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:1px solid #e4e4e7;border-radius:10px;background:#fafafa;">
        <tr><td style="padding:14px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0">${lines}</table>
          <div style="margin-top:8px;color:#71717a;font-size:12px;">Renews ${freq}${next ? ` · next charge ${next}` : ""}</div>
        </td></tr>
      </table>`;
  }).join("");

  return `<div style="margin-top:24px;"><div style="color:#71717a;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Your subscription</div>${rows}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Branded, trust-signal-heavy recovery email. Logo header + workspace
 * color + subscription details + secure-payment badges + a clear "why
 * you got this / we'll never ask for X" footer so it reads as official,
 * not phishing.
 */
function buildRecoveryEmailHtml(opts: {
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string;
  firstName: string | null;
  link: string;
  supportEmail: string;
  subscriptionsHtml: string;
}): string {
  const { workspaceName, logoUrl, primaryColor, firstName, link, supportEmail, subscriptionsHtml } = opts;
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : "Hi there,";
  const logo = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeHtml(workspaceName)}" height="40" style="height:40px;width:auto;display:inline-block;" />`
    : `<span style="font-size:20px;font-weight:700;color:${primaryColor};">${escapeHtml(workspaceName)}</span>`;

  const trustItem = (icon: string, text: string) =>
    `<td valign="top" style="padding:0 6px;width:33%;text-align:center;">
       <div style="font-size:18px;line-height:1.2;">${icon}</div>
       <div style="font-size:11px;color:#52525b;line-height:1.4;margin-top:4px;">${text}</div>
     </td>`;

  return `
  <div style="background:#f4f4f5;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e4e4e7;">
          <!-- Header / logo -->
          <tr><td style="padding:24px;text-align:center;border-bottom:1px solid #f0f0f0;">${logo}</td></tr>

          <!-- Body -->
          <tr><td style="padding:28px 28px 8px;">
            <h1 style="margin:0 0 6px;color:#18181b;font-size:19px;">${greeting}</h1>
            <p style="margin:0;color:#52525b;font-size:14px;line-height:1.6;">
              We weren't able to process the payment for your subscription, so your next order is on hold. To keep it active, please update your payment method — it takes about 30 seconds and we'll take care of the rest.
            </p>
            ${subscriptionsHtml}
            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:28px 0 8px;"><tr><td align="center">
              <a href="${link}" style="display:inline-block;padding:15px 36px;background:${primaryColor};color:#ffffff !important;text-decoration:none;border-radius:10px;font-size:15px;font-weight:700;">
                Update my payment method
              </a>
              <div style="margin-top:10px;font-size:12px;color:#a1a1aa;">🔒 Secure link — expires in 7 days</div>
            </td></tr></table>
          </td></tr>

          <!-- Trust signals -->
          <tr><td style="padding:16px 20px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f8faf9;border-radius:10px;">
              <tr>
                ${trustItem("🔒", "256-bit encrypted, PCI-compliant checkout")}
                ${trustItem("💳", "We never see or store your full card number")}
                ${trustItem("↩️", "Change or cancel anytime")}
              </tr>
            </table>
          </td></tr>

          <!-- Anti-phishing footer -->
          <tr><td style="padding:8px 28px 28px;">
            <p style="margin:0 0 10px;color:#a1a1aa;font-size:12px;line-height:1.6;">
              <strong>Why you're getting this:</strong> you have a subscription with ${escapeHtml(workspaceName)} and your last payment didn't go through. This is a genuine email from us — we'll <strong>never</strong> ask for your password or full card number by email, and the button above goes only to your secure ${escapeHtml(workspaceName)} account.
            </p>
            <p style="margin:0;color:#a1a1aa;font-size:12px;line-height:1.6;">
              Questions or trouble updating? Just reply to this email — it reaches our support team directly — or contact us at <a href="mailto:${supportEmail}" style="color:${primaryColor};">${supportEmail}</a>.
            </p>
          </td></tr>
        </table>
        <div style="margin-top:14px;color:#a1a1aa;font-size:11px;text-align:center;">© ${escapeHtml(workspaceName)}</div>
      </td></tr>
    </table>
  </div>`;
}
