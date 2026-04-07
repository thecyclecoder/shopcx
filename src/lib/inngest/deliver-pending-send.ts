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

        if (!ticket || ticket.channel !== "email") {
          // Non-email channel — just mark as sent
          await admin.from("ticket_messages").update({
            sent_at: new Date().toISOString(),
            pending_send_at: null,
          }).eq("id", msg.id);
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
          await sendTicketReply({
            workspaceId: ticket.workspace_id,
            toEmail: email,
            subject: `Re: ${ticket.subject || "Your request"}`,
            body: msg.body,
            inReplyTo: ticket.email_message_id || null,
            agentName: "Support",
            workspaceName: ws?.name || "",
          });

          await admin.from("ticket_messages").update({
            sent_at: new Date().toISOString(),
            pending_send_at: null,
          }).eq("id", msg.id);
          delivered++;
        } catch (err) {
          console.error(`[deliver-pending] Failed to send message ${msg.id}:`, err);
        }
      });
    }

    return { delivered, cancelled, total: messages.length };
  },
);
