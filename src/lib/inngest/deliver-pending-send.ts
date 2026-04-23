/**
 * Deliver pending outbound messages after the response delay.
 * Runs every 30 seconds, picks up messages where pending_send_at has passed.
 * Checks for newer customer activity — if customer replied, cancels the pending send.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendTicketReply } from "@/lib/email";

export const deliverPendingSends = inngest.createFunction(
  {
    id: "deliver-pending-sends",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "* * * * *" }], // Every minute
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const messages = await step.run("find-pending", async () => {
      const { data } = await admin
        .from("ticket_messages")
        .select("id, ticket_id, body, created_at, pending_send_at")
        .not("pending_send_at", "is", null)
        .is("sent_at", null)
        .eq("send_cancelled", false)
        .lte("pending_send_at", new Date().toISOString())
        .order("pending_send_at", { ascending: true })
        .limit(20);

      return data || [];
    });

    if (messages.length === 0) return { delivered: 0 };

    let delivered = 0;
    let cancelled = 0;

    for (const msg of messages) {
      await step.run(`deliver-${msg.id.slice(0, 8)}`, async () => {
        // Check for newer customer activity since this message was created
        const { data: newerInbound } = await admin
          .from("ticket_messages")
          .select("id")
          .eq("ticket_id", msg.ticket_id)
          .eq("direction", "inbound")
          .gt("created_at", msg.created_at)
          .limit(1)
          .single();

        if (newerInbound) {
          // Customer replied — cancel this pending send
          await admin.from("ticket_messages").update({
            send_cancelled: true,
          }).eq("id", msg.id);
          cancelled++;
          return;
        }

        // Get ticket info for email delivery
        const { data: ticket } = await admin
          .from("tickets")
          .select("workspace_id, subject, email_message_id, channel, customers(email)")
          .eq("id", msg.ticket_id)
          .single();

        if (!ticket) {
          await admin.from("ticket_messages").update({ sent_at: new Date().toISOString(), pending_send_at: null }).eq("id", msg.id);
          return;
        }

        // Chat channel — check if customer is idle, send via email if so
        if (ticket.channel === "chat") {
          await admin.from("ticket_messages").update({ sent_at: new Date().toISOString(), pending_send_at: null }).eq("id", msg.id);
          delivered++;

          const { getDeliveryChannel } = await import("@/lib/delivery-channel");
          const effectiveCh = await getDeliveryChannel(msg.ticket_id, "chat");
          if (effectiveCh === "email") {
            const email = (ticket.customers as unknown as { email: string })?.email;
            if (email) {
              const { data: ws } = await admin.from("workspaces").select("name").eq("id", ticket.workspace_id).single();

              // Convert embedded journey forms to CTA email links (forms don't render in email)
              let emailBody = msg.body;
              const journeyMatch = emailBody.match(/<!--JOURNEY:(\{[\s\S]*?\})-->/);
              if (journeyMatch) {
                try {
                  const journeyData = JSON.parse(journeyMatch[1]);
                  const token = journeyData.token;
                  if (token) {
                    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
                    const journeyUrl = `${siteUrl}/journey/${token}`;
                    const buttonText = journeyData.ctaText || "Continue Here";
                    const { data: wsColor } = await admin.from("workspaces").select("help_primary_color").eq("id", ticket.workspace_id).single();
                    const brandColor = wsColor?.help_primary_color || "#4f46e5";
                    // Replace the embedded form with a styled CTA button (leadIn text is already before the embed)
                    emailBody = emailBody.replace(journeyMatch[0],
                      `<p><a href="${journeyUrl}" style="display:inline-block;margin:8px 0;padding:12px 24px;background:${brandColor};color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">${buttonText}</a></p>`
                    );
                  }
                } catch { /* keep original body if parse fails */ }
              }

              const chatEmailResult = await sendTicketReply({
                workspaceId: ticket.workspace_id, toEmail: email,
                subject: `Re: ${ticket.subject || "Your chat with us"}`,
                body: emailBody, inReplyTo: null,
                agentName: "Support", workspaceName: ws?.name || "",
              });
              if (chatEmailResult.messageId) {
                await admin.from("ticket_messages").update({ resend_email_id: chatEmailResult.messageId, email_status: "sent" }).eq("id", msg.id);
                const { logEmailSent } = await import("@/lib/email-tracking");
                const { data: t } = await admin.from("tickets").select("customer_id").eq("id", msg.ticket_id).single();
                await logEmailSent({ workspaceId: ticket.workspace_id, resendEmailId: chatEmailResult.messageId, recipientEmail: email, subject: ticket.subject || "Your chat with us", ticketId: msg.ticket_id, customerId: t?.customer_id });
              }
            }
          }
          return;
        }

        if (ticket.channel !== "email") {
          // Other non-email channels — just mark as sent
          await admin.from("ticket_messages").update({ sent_at: new Date().toISOString(), pending_send_at: null }).eq("id", msg.id);
          delivered++;
          return;
        }

        const email = (ticket.customers as unknown as { email: string })?.email;
        if (!email) {
          await admin.from("ticket_messages").update({ sent_at: new Date().toISOString(), pending_send_at: null }).eq("id", msg.id);
          return;
        }

        const { data: ws } = await admin.from("workspaces")
          .select("name")
          .eq("id", ticket.workspace_id)
          .single();

        try {
          const emailResult = await sendTicketReply({
            workspaceId: ticket.workspace_id,
            toEmail: email,
            subject: `Re: ${ticket.subject || "Your request"}`,
            body: msg.body,
            inReplyTo: ticket.email_message_id || null,
            agentName: "Support",
            workspaceName: ws?.name || "",
          });

          const resendId = emailResult.messageId || null;
          await admin.from("ticket_messages").update({
            sent_at: new Date().toISOString(),
            pending_send_at: null,
            resend_email_id: resendId,
            email_status: resendId ? "sent" : null,
            email_message_id: resendId ? `<${resendId}@resend.dev>` : undefined,
          }).eq("id", msg.id);

          // Log email event for tracking
          if (resendId) {
            const { logEmailSent } = await import("@/lib/email-tracking");
            const { data: t } = await admin.from("tickets").select("customer_id").eq("id", msg.ticket_id).single();
            await logEmailSent({
              workspaceId: ticket.workspace_id,
              resendEmailId: resendId,
              recipientEmail: email,
              subject: ticket.subject || "Your request",
              ticketId: msg.ticket_id,
              customerId: t?.customer_id,
            });
          }
          delivered++;
        } catch (err) {
          console.error(`[deliver-pending] Failed to send message ${msg.id}:`, err);
        }
      });
    }

    return { delivered, cancelled, total: messages.length };
  },
);
