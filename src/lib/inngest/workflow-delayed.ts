import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeWorkflow } from "@/lib/workflow-executor";
import { sendTicketReply } from "@/lib/email";

// Execute workflow with configurable channel-based response delay
export const workflowDelayed = inngest.createFunction(
  {
    id: "workflow-delayed-execute",
    retries: 2,
    concurrency: [{ limit: 10, key: "event.data.workspace_id" }],
    triggers: [{ event: "workflow/execute" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ticket_id, trigger_tag, channel } = event.data as {
      workspace_id: string;
      ticket_id: string;
      trigger_tag: string;
      channel: string;
    };

    // Get the configured delay for this channel
    const delaySeconds = await step.run("get-delay", async () => {
      const admin = createAdminClient();
      const { data: ws } = await admin
        .from("workspaces")
        .select("response_delays")
        .eq("id", workspace_id)
        .single();

      const delays = (ws?.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10 }) as Record<string, number>;
      return delays[channel] || 60;
    });

    // Wait the configured delay
    if (delaySeconds > 0) {
      await step.sleep("response-delay", `${delaySeconds}s`);
    }

    // Check if auto-reply was cancelled by an agent during the delay
    const cancelled = await step.run("check-cancelled", async () => {
      const admin = createAdminClient();
      const { data: ticket } = await admin.from("tickets").select("auto_reply_at").eq("id", ticket_id).single();
      return !ticket?.auto_reply_at;
    });

    if (cancelled) {
      return { delayed: delaySeconds, channel, cancelled: true };
    }

    // Execute the workflow
    await step.run("execute-workflow", async () => {
      await executeWorkflow(workspace_id, ticket_id, trigger_tag);
    });

    return { delayed: delaySeconds, channel, cancelled: false };
  }
);

// Delayed positive confirmation auto-close
export const positiveCloseDelayed = inngest.createFunction(
  {
    id: "workflow-positive-close",
    retries: 2,
    triggers: [{ event: "workflow/positive-close" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ticket_id, channel } = event.data as {
      workspace_id: string;
      ticket_id: string;
      channel: string;
    };

    const admin = createAdminClient();

    // Get delay
    const delaySeconds = await step.run("get-delay", async () => {
      const { data: ws } = await admin.from("workspaces").select("response_delays").eq("id", workspace_id).single();
      const delays = (ws?.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10 }) as Record<string, number>;
      return delays[channel] || 60;
    });

    if (delaySeconds > 0) {
      await step.sleep("response-delay", `${delaySeconds}s`);
    }

    // Check if cancelled
    const cancelled = await step.run("check-cancelled", async () => {
      const { data: ticket } = await admin.from("tickets").select("auto_reply_at").eq("id", ticket_id).single();
      return !ticket?.auto_reply_at;
    });

    if (cancelled) return { cancelled: true };

    // Send the auto-close reply
    await step.run("send-close-reply", async () => {
      const { data: ws } = await admin.from("workspaces").select("name, auto_close_reply").eq("id", workspace_id).single();
      const autoCloseReply = ws?.auto_close_reply || "You're welcome! If you need anything else, we're always here to help.";

      const { data: ticket } = await admin.from("tickets").select("subject, customer_id, email_message_id").eq("id", ticket_id).single();

      // Insert message
      await admin.from("ticket_messages").insert({
        ticket_id,
        direction: "outbound",
        visibility: "external",
        author_type: "system",
        body: autoCloseReply,
      });

      // Send email
      if (ticket?.customer_id) {
        const { data: cust } = await admin.from("customers").select("email").eq("id", ticket.customer_id).single();
        if (cust?.email) {
          await sendTicketReply({
            workspaceId: workspace_id,
            toEmail: cust.email,
            subject: (ticket.subject as string) || "Support",
            body: autoCloseReply,
            inReplyTo: (ticket.email_message_id as string) || null,
            agentName: "Support",
            workspaceName: ws?.name || "Support",
          });
        }
      }

      // Close the ticket
      await admin.from("tickets").update({
        status: "closed",
        auto_reply_at: null,
        pending_auto_reply: null,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", ticket_id);
    });

    return { cancelled: false };
  }
);
