/**
 * Portal ticket email delivery.
 *
 * When we respond on a portal-channel ticket we ALWAYS email the
 * customer (they submitted via the portal "Support" sidebar and aren't
 * necessarily sitting in a live chat window). The email shows our most
 * recent message on top, then the conversation history below it.
 *
 * Internal messages (system notes, AI drafts, `[System] …` orchestration
 * logs) are NEVER included — only external inbound/outbound messages.
 *
 * Mirrors the chat→email threading: the sent email's Message-ID is saved
 * back onto the ticket so a customer's email reply threads into the same
 * ticket.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTicketReply } from "@/lib/email";

type Admin = SupabaseClient;

interface PortalMsg {
  direction: string;
  author_type: string | null;
  body: string | null;
  created_at: string;
}

/** Replace an embedded journey form (`<!--JOURNEY:{…}-->`) with a styled CTA
 *  button — forms don't render in email. No-op when there's no embed. */
async function journeyEmbedToCta(admin: Admin, wsId: string, html: string): Promise<string> {
  const m = html.match(/<!--JOURNEY:(\{[\s\S]*?\})-->/);
  if (!m) return html;
  try {
    const j = JSON.parse(m[1]);
    if (!j.token) return html.replace(m[0], "");
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
    const url = `${siteUrl}/journey/${j.token}`;
    const { data: ws } = await admin.from("workspaces").select("help_primary_color").eq("id", wsId).single();
    const brand = ws?.help_primary_color || "#4f46e5";
    const label = j.ctaText || "Continue Here";
    return html.replace(
      m[0],
      `<p><a href="${url}" style="display:inline-block;margin:8px 0;padding:12px 24px;background:${brand};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${label}</a></p>`,
    );
  } catch {
    return html.replace(m[0], "");
  }
}

function fmtTime(iso: string): string {
  // Render in a stable, human format without locale surprises.
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

/**
 * Build + send the portal reply email for a ticket. Call AFTER the
 * outbound message row has been inserted. Returns the Resend message id
 * (also threaded back onto the ticket), or null on no-op/failure.
 */
export async function sendPortalThreadEmail(admin: Admin, wsId: string, ticketId: string): Promise<string | null> {
  const { data: ticket } = await admin
    .from("tickets")
    .select("subject, customer_id, email_message_id")
    .eq("id", ticketId)
    .single();
  if (!ticket?.customer_id) return null;

  const { data: cust } = await admin.from("customers").select("email").eq("id", ticket.customer_id).single();
  if (!cust?.email) return null;

  // External messages only — never internal notes / AI drafts / system logs.
  const { data: msgs } = await admin
    .from("ticket_messages")
    .select("direction, author_type, body, created_at")
    .eq("ticket_id", ticketId)
    .eq("visibility", "external")
    .order("created_at", { ascending: true });

  const external = (msgs || []) as PortalMsg[];
  if (!external.length) return null;

  // Latest outbound (our recent message) goes on top; everything else is history.
  const latest = [...external].reverse().find((m) => m.direction === "outbound") || external[external.length - 1];
  const topHtml = await journeyEmbedToCta(admin, wsId, latest.body || "");

  // History: every external message except the one on top, newest first.
  const history = external
    .filter((m) => m !== latest)
    .reverse()
    .map((m) => {
      const who = m.direction === "outbound" ? "Support" : "You";
      return `
        <div style="margin:0 0 16px;padding:0 0 16px;border-bottom:1px solid #eee;">
          <div style="font-size:12px;color:#888;margin-bottom:4px;">${who} · ${fmtTime(m.created_at)}</div>
          <div style="color:#333;">${m.body || ""}</div>
        </div>`;
    })
    .join("");

  const body = `
    <div>${topHtml}</div>
    ${history ? `<div style="margin-top:28px;"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#999;margin-bottom:12px;">Conversation history</div>${history}</div>` : ""}
  `;

  const { data: ws } = await admin.from("workspaces").select("name").eq("id", wsId).single();
  const res = await sendTicketReply({
    workspaceId: wsId,
    toEmail: cust.email,
    subject: `Re: ${ticket.subject || "Your request"}`,
    body,
    inReplyTo: ticket.email_message_id || null,
    agentName: "Support",
    workspaceName: ws?.name || "",
  });

  if (res.messageId) {
    const emailMsgId = `<${res.messageId}@resend.dev>`;
    // Thread future email replies back into this ticket.
    await admin.from("tickets").update({ email_message_id: emailMsgId }).eq("id", ticketId);
    const { logEmailSent } = await import("@/lib/email-tracking");
    await logEmailSent({ workspaceId: wsId, resendEmailId: res.messageId, recipientEmail: cust.email, subject: ticket.subject || "Your request", ticketId, customerId: ticket.customer_id });
    return res.messageId;
  }
  return null;
}
