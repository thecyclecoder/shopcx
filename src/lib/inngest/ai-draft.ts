// Inngest function: generate AI draft for new tickets
// Triggered by email webhook or manual request

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAIDraft } from "@/lib/ai-draft";
import { sendTicketReply } from "@/lib/email";

export const aiDraftTicket = inngest.createFunction(
  {
    id: "ai-draft-ticket",
    retries: 1,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "ai/draft-ticket" }],
  },
  async ({ event, step }) => {
    const { ticket_id, workspace_id } = event.data as {
      ticket_id: string;
      workspace_id: string;
    };

    // Step 1: Generate AI draft
    const result = await step.run("generate-draft", async () => {
      return generateAIDraft(workspace_id, ticket_id);
    });

    if (!result.draft || result.tier === "human") {
      return { tier: result.tier, confidence: result.confidence, action: "none" };
    }

    // Step 2: If auto tier AND not sandbox → send response
    if (result.tier === "auto" && !result.sandbox) {
      await step.run("auto-send", async () => {
        const admin = createAdminClient();

        // Get ticket details for sending
        const { data: ticket } = await admin
          .from("tickets")
          .select("*, customers(email, first_name, last_name)")
          .eq("id", ticket_id)
          .single();

        if (!ticket || !ticket.customers) return;

        const customerEmail = (ticket.customers as { email: string }).email;

        // Get workspace name
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspace_id).single();

        // Send reply
        await sendTicketReply({
          workspaceId: workspace_id,
          toEmail: customerEmail,
          subject: ticket.subject ? `Re: ${ticket.subject}` : "Re: Your request",
          body: result.draft,
          inReplyTo: ticket.email_message_id || null,
          agentName: "AI Agent",
          workspaceName: ws?.name || "Support",
        });

        // Create outbound message
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: result.draft,
          author_type: "ai",
          visibility: "public",
        });

        // Update ticket status
        await admin
          .from("tickets")
          .update({ status: "pending", ai_handled: true })
          .eq("id", ticket_id);
      });

      // Step 3: Schedule auto-close in 48h
      await step.sleep("wait-48h", "48h");

      await step.run("auto-close-check", async () => {
        const admin = createAdminClient();
        const { data: ticket } = await admin
          .from("tickets")
          .select("status")
          .eq("id", ticket_id)
          .single();

        // Only close if still pending (customer hasn't replied)
        if (ticket?.status === "pending") {
          await admin
            .from("tickets")
            .update({ status: "closed", resolved_at: new Date().toISOString() })
            .eq("id", ticket_id);
        }
      });

      return { tier: "auto", confidence: result.confidence, action: "sent" };
    }

    // If sandbox mode: create internal note instead
    if (result.tier === "auto" && result.sandbox) {
      await step.run("sandbox-internal-note", async () => {
        const admin = createAdminClient();
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[AI Draft — Sandbox Mode]\n\n${result.draft}\n\nConfidence: ${Math.round(result.confidence * 100)}% | Source: ${result.source_type || "none"}`,
          author_type: "ai",
          visibility: "internal",
        });
      });

      return { tier: "auto", confidence: result.confidence, action: "sandbox_note" };
    }

    // Review tier: draft is already stored on ticket, nothing more to do
    return { tier: result.tier, confidence: result.confidence, action: "draft_stored" };
  }
);

// Trigger AI workflow post-response action
export const aiTriggerWorkflow = inngest.createFunction(
  {
    id: "ai-trigger-workflow",
    retries: 1,
    triggers: [{ event: "ai/trigger-workflow" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ticket_id, workflow_id } = event.data as {
      workspace_id: string;
      ticket_id: string;
      workflow_id: string;
    };

    await step.run("execute-workflow", async () => {
      const admin = createAdminClient();
      const { data: aiWorkflow } = await admin
        .from("ai_workflows")
        .select("post_response_workflow_id")
        .eq("id", workflow_id)
        .single();

      if (aiWorkflow?.post_response_workflow_id) {
        const { data: workflow } = await admin
          .from("workflows")
          .select("trigger_tag")
          .eq("id", aiWorkflow.post_response_workflow_id)
          .single();

        if (workflow) {
          const { executeWorkflow } = await import("@/lib/workflow-executor");
          await executeWorkflow(workspace_id, ticket_id, workflow.trigger_tag);
        }
      }
    });

    return { executed: true };
  }
);
