/**
 * _campaign-send — send a campaign email THROUGH a ticket, so a reply is visible and threads.
 *
 * CEO 2026-07-30: "when we send those emails we need to create a closed ticket so that if people
 * reply we can at least see that we sent them that message."
 *
 * TWO THINGS THIS FIXES
 *
 * 1. REPLY-TO. The first cut used `workspaces.transactional_reply_to_email`, which on this
 *    workspace is `no-reply@superfoodscompany.com` — replies land nowhere. Production ticket
 *    replies (`sendTicketReply`) use `support_email || support@{resend_domain}`, which is the
 *    address inbound mail is actually processed on. Campaign mail now uses the SAME address, so a
 *    reply reaches us like any other customer email.
 *
 * 2. THREADING. A reply carries `In-Reply-To: <{resendMessageId}@resend.dev>`. The inbound matcher
 *    finds the ticket by `tickets.email_message_id`, so that value must be stamped on BOTH the
 *    ticket and the outbound message AFTER the send returns its id — the same anchoring
 *    `/api/tickets` does. Without it a reply arrives as an orphan with no history.
 *
 * The ticket is created CLOSED: we are not asking for a response, and an open ticket per recipient
 * would flood the queue with hundreds of items nobody needs to action. A reply re-opens it through
 * the normal inbound path, and the agent then sees exactly what we sent.
 */
import { createAdminClient } from "../src/lib/supabase/admin";

export interface CampaignSendResult { ok: boolean; ticketId?: string; messageId?: string; error?: string }

export async function sendCampaignEmailAsTicket(opts: {
  workspaceId: string;
  customerId: string;
  toEmail: string;
  subject: string;
  html: string;   // full brand-shelled document
  text: string;
  tags?: string[];
  /** Distinguishes campaigns in the ticket record. */
  source: string;
}): Promise<CampaignSendResult> {
  const admin = createAdminClient() as any;

  const { data: ws } = await admin.from("workspaces")
    .select("name, resend_api_key_encrypted, resend_domain, support_email, transactional_from_name")
    .eq("id", opts.workspaceId).maybeSingle();
  if (!ws?.resend_api_key_encrypted || !ws?.resend_domain) return { ok: false, error: "Resend not configured" };

  const { decrypt } = await import("../src/lib/crypto");
  const key = decrypt(ws.resend_api_key_encrypted);
  const domain = ws.resend_domain as string;
  // SAME reply-to production ticket replies use — the address inbound mail is processed on.
  const replyTo = (ws.support_email as string | null) || `support@${domain}`;
  const fromName = (ws.transactional_from_name as string | null) || (ws.name as string) || "Superfoods Company";

  // 1. The ticket — closed, because we are not asking for a response.
  const { data: ticket, error: tErr } = await admin.from("tickets").insert({
    workspace_id: opts.workspaceId,
    customer_id: opts.customerId,
    channel: "email",
    status: "closed",
    subject: opts.subject,
    tags: opts.tags ?? [],
    ai_handled: false,
    closed_at: new Date().toISOString(),
    resolved_at: new Date().toISOString(),
  }).select("id").single();
  if (tErr) return { ok: false, error: `ticket: ${tErr.message}` };

  // 2. The outbound message — recorded BEFORE the send so a crash mid-send still leaves the record.
  const { data: msg } = await admin.from("ticket_messages").insert({
    ticket_id: ticket.id, direction: "outbound", visibility: "external", author_type: "system",
    body: opts.html, sent_at: new Date().toISOString(),
  }).select("id").single();

  // 3. Send.
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const { data, error } = await resend.emails.send({
    from: `${fromName} <orders@${domain}>`,
    to: opts.toEmail, subject: opts.subject, html: opts.html, text: opts.text, replyTo,
  });
  if (error) {
    await admin.from("ticket_messages").update({ email_status: "failed" }).eq("id", msg?.id);
    return { ok: false, ticketId: ticket.id, error: error.message };
  }

  // 4. Anchor the threading key on BOTH rows — this is what lets a reply find its ticket.
  const emailMessageId = `<${data?.id}@resend.dev>`;
  await admin.from("ticket_messages").update({
    resend_email_id: data?.id, email_status: "sent", email_message_id: emailMessageId,
  }).eq("id", msg?.id);
  await admin.from("tickets").update({ email_message_id: emailMessageId }).eq("id", ticket.id);

  return { ok: true, ticketId: ticket.id, messageId: data?.id };
}
