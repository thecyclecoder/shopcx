// Inngest function: generate AI draft for new tickets
// Flow: generate draft immediately → post as ghost preview → wait delay → send if not cancelled

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
    const { ticket_id, workspace_id, delay_seconds } = event.data as {
      ticket_id: string;
      workspace_id: string;
      channel?: string;
      delay_seconds?: number;
    };

    // Step 1: Generate AI draft immediately
    const result = await step.run("generate-draft", async () => {
      return generateAIDraft(workspace_id, ticket_id);
    });

    // Step 2: Update ticket with draft as ghost preview (agent sees it immediately)
    await step.run("post-preview", async () => {
      const admin = createAdminClient();
      const delaySec = delay_seconds || 300;
      const autoReplyAt = new Date(Date.now() + delaySec * 1000).toISOString();

      const updates: Record<string, unknown> = {
        ai_draft: result.draft || null,
        ai_confidence: result.confidence,
        ai_tier: result.tier,
        ai_source_type: result.source_type,
        ai_source_id: result.source_id,
        ai_workflow_id: result.ai_workflow_id,
        ai_drafted_at: new Date().toISOString(),
        ai_suggested_macro_id: result.source_type === "macro" ? result.source_id : null,
      };

      // If we have a suggested macro, save its name for easy display
      if (result.source_type === "macro" && result.source_id) {
        const { data: macro } = await admin.from("macros").select("name").eq("id", result.source_id).single();
        updates.ai_suggested_macro_name = macro?.name || null;
      }

      if (result.draft && result.tier !== "human") {
        // Post as pending auto-reply ghost message (cyan for AI, different from purple workflows)
        updates.pending_auto_reply = result.draft;
        updates.auto_reply_at = autoReplyAt;
      } else {
        // No draft or human tier — clear the pending state
        updates.pending_auto_reply = null;
        updates.auto_reply_at = null;
      }

      await admin.from("tickets").update(updates).eq("id", ticket_id);
    });

    if (!result.draft || result.tier === "human") {
      return { tier: result.tier, confidence: result.confidence, action: "none" };
    }

    // Step 3: Wait the channel delay
    const delaySec = delay_seconds || 300;
    if (delaySec > 0) {
      await step.sleep("channel-delay", `${delaySec}s`);
    }

    // Step 4: Check if agent cancelled (cleared auto_reply_at)
    const cancelled = await step.run("check-cancelled", async () => {
      const admin = createAdminClient();
      const { data: ticket } = await admin
        .from("tickets")
        .select("auto_reply_at, status")
        .eq("id", ticket_id)
        .single();

      // Cancelled if auto_reply_at was cleared, or ticket was closed/already replied
      return !ticket?.auto_reply_at || ticket.status === "closed";
    });

    if (cancelled) {
      return { tier: result.tier, confidence: result.confidence, action: "cancelled" };
    }

    // Step 5: Send based on tier + sandbox
    if (result.tier === "auto" && !result.sandbox) {
      await step.run("auto-send", async () => {
        const admin = createAdminClient();

        const { data: ticket } = await admin
          .from("tickets")
          .select("*, customers(email, first_name, last_name)")
          .eq("id", ticket_id)
          .single();

        if (!ticket || !ticket.customers) return;

        const customerEmail = (ticket.customers as { email: string }).email;
        const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspace_id).single();

        await sendTicketReply({
          workspaceId: workspace_id,
          toEmail: customerEmail,
          subject: ticket.subject ? `Re: ${ticket.subject}` : "Re: Your request",
          body: result.draft,
          inReplyTo: ticket.email_message_id || null,
          agentName: "AI Agent",
          workspaceName: ws?.name || "Support",
        });

        // Create outbound message with macro tracking
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: result.draft,
          author_type: "ai",
          visibility: "external",
          macro_id: result.source_type === "macro" ? result.source_id : null,
          ai_personalized: true,
        });

        // Update ticket
        await admin
          .from("tickets")
          .update({
            status: "pending",
            ai_handled: true,
            handled_by: "AI Agent",
            auto_reply_at: null,
            pending_auto_reply: null,
          })
          .eq("id", ticket_id);

        // Increment macro usage + log
        if (result.source_type === "macro" && result.source_id) {
          try { await admin.rpc("increment_macro_usage", { macro_id: result.source_id }); } catch {}
          try {
            await admin.from("macro_usage_log").insert({
              workspace_id,
              macro_id: result.source_id,
              ticket_id,
              source: "ai_auto",
              outcome: "auto_sent",
              ai_confidence: result.confidence,
            });
          } catch {}
        }
      });

      // Schedule auto-close in 48h
      await step.sleep("wait-48h", "48h");

      await step.run("auto-close-check", async () => {
        const admin = createAdminClient();
        const { data: ticket } = await admin.from("tickets").select("status").eq("id", ticket_id).single();
        if (ticket?.status === "pending") {
          await admin.from("tickets").update({ status: "closed", resolved_at: new Date().toISOString() }).eq("id", ticket_id);
        }
      });

      return { tier: "auto", confidence: result.confidence, action: "sent" };
    }

    // Sandbox mode: create internal note
    if (result.tier === "auto" && result.sandbox) {
      await step.run("sandbox-internal-note", async () => {
        const admin = createAdminClient();
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[AI Draft — Sandbox Mode]\n\n${result.draft}\n\nConfidence: ${Math.round(result.confidence * 100)}% | Source: ${result.source_type || "none"}`,
          author_type: "ai",
          visibility: "internal",
          macro_id: result.source_type === "macro" ? result.source_id : null,
          ai_personalized: true,
        });

        await admin.from("tickets").update({ auto_reply_at: null, pending_auto_reply: null }).eq("id", ticket_id);
      });

      return { tier: "auto", confidence: result.confidence, action: "sandbox_note" };
    }

    // Review tier: draft is stored, agent sees it. Clear the auto-reply timer.
    await step.run("clear-auto-reply", async () => {
      const admin = createAdminClient();
      await admin.from("tickets").update({ auto_reply_at: null }).eq("id", ticket_id);
    });

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
