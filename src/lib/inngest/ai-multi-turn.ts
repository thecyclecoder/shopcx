// Multi-turn AI conversation handler
// Triggered when a customer replies to a ticket where AI is active

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleTicketContext } from "@/lib/ai-context";
import { routeInboundReply } from "@/lib/turn-router";
import { handleEscalation } from "@/lib/escalation";
import { sendTicketReply } from "@/lib/email";
import { subscribeToMarketing } from "@/lib/shopify-marketing";

export const aiMultiTurn = inngest.createFunction(
  {
    id: "ai-multi-turn",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.ticket_id" }],
    triggers: [{ event: "ai/reply-received" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ticket_id, message_body } = event.data as {
      workspace_id: string;
      ticket_id: string;
      message_body: string;
    };

    // Step 1: Route the reply
    const decision = await step.run("route-reply", async () => {
      return routeInboundReply(ticket_id, message_body);
    });

    // Handle close check — AI sends a brief closing message and closes the ticket
    if (decision.action === "close_check") {
      await step.run("ai-positive-close", async () => {
        const admin = createAdminClient();

        const { data: ticket } = await admin
          .from("tickets")
          .select("subject, customers(email, first_name), handled_by")
          .eq("id", ticket_id)
          .single();

        const isAIHandled = ticket?.handled_by === "AI Agent";
        const firstName = (ticket?.customers as unknown as { first_name: string | null })?.first_name;

        // Only do AI closure if this was an AI-handled ticket
        if (!isAIHandled) {
          // Fall back to existing workflow for non-AI tickets
          await inngest.send({
            name: "workflow/positive-close",
            data: { workspace_id, ticket_id },
          });
          return;
        }

        // Brief closing message
        const closeMsg = firstName
          ? `Happy to help, ${firstName}! Don't hesitate to reach out if you need anything else.`
          : "Happy to help! Don't hesitate to reach out if you need anything else.";

        // Get workspace for sandbox check
        const { data: ws } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", workspace_id).single();
        const customerEmail = (ticket?.customers as unknown as { email: string })?.email;

        if (ws && !ws.sandbox_mode && customerEmail) {
          await sendTicketReply({
            workspaceId: workspace_id,
            toEmail: customerEmail,
            subject: ticket?.subject ? `Re: ${ticket.subject}` : "Re: Your request",
            body: closeMsg,
            inReplyTo: null,
            agentName: "AI Agent",
            workspaceName: ws.name,
          });

          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: closeMsg,
            author_type: "ai",
            visibility: "external",
          });
        } else {
          // Sandbox mode
          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: `[AI Draft — Sandbox Mode — Close]\n\n${closeMsg}`,
            author_type: "ai",
            visibility: "internal",
          });
        }

        // Close the ticket
        await admin.from("tickets").update({
          status: "closed",
          resolved_at: new Date().toISOString(),
          auto_reply_at: null,
          pending_auto_reply: null,
        }).eq("id", ticket_id);
      });
      return { action: "closed", reason: decision.reason };
    }

    // Handle escalation
    if (decision.action === "escalate") {
      await step.run("escalate", async () => {
        await handleEscalation(workspace_id, ticket_id, decision.reason);
      });
      return { action: "escalated", reason: decision.reason };
    }

    // Step 2: Assemble context
    const context = await step.run("assemble-context", async () => {
      return assembleTicketContext(workspace_id, ticket_id);
    });

    // Step 2b: KB gap check — if no KB chunks or macros matched, don't wing it
    if (context.ragContext.chunks.length === 0 && context.ragContext.macros.length === 0) {
      await step.run("kb-gap-detected", async () => {
        const admin = createAdminClient();

        // Create internal note about the gap
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[Knowledge Base Gap Detected]\n\nNo matching KB articles or macros found for this question. Suggested KB article: "${message_body.slice(0, 100)}"\n\nTicket left for human agent.`,
          author_type: "system",
          visibility: "internal",
        });

        // Create notification for admins
        await admin.from("dashboard_notifications").insert({
          workspace_id,
          type: "knowledge_gap",
          title: "Knowledge base gap detected",
          body: `AI couldn't find relevant content for: "${message_body.slice(0, 120)}"`,
          link: `/dashboard/knowledge-base`,
          metadata: { ticket_id, query: message_body.slice(0, 500) },
        });

        // Assign to agent
        await handleEscalation(workspace_id, ticket_id, "knowledge_gap");
      });
      return { action: "kb_gap", reason: "No matching KB articles or macros" };
    }

    // Step 3: Get response delay
    const delay = await step.run("get-delay", async () => {
      const admin = createAdminClient();
      const { data: ws } = await admin.from("workspaces").select("response_delays").eq("id", workspace_id).single();
      const delays = (ws?.response_delays || { email: 60, chat: 5, sms: 10, meta_dm: 10, help_center: 5, social_comments: 10 }) as Record<string, number>;
      return delays[context.channel] || 60;
    });

    // Wait for response delay
    if (delay > 0) {
      await step.sleep("response-delay", `${delay}s`);
    }

    // Check if agent cancelled the auto-reply
    const cancelled = await step.run("check-cancelled", async () => {
      const admin = createAdminClient();
      const { data: ticket } = await admin.from("tickets").select("auto_reply_at, assigned_to, agent_intervened").eq("id", ticket_id).single();
      // If agent has been assigned or intervened, stop AI
      if (ticket?.assigned_to || ticket?.agent_intervened) return true;
      return false;
    });

    if (cancelled) {
      return { action: "cancelled", reason: "agent_intervened" };
    }

    // Step 4: Generate response
    const aiResponse = await step.run("generate-response", async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("No ANTHROPIC_API_KEY");

      // Use Haiku for turns 1-2, Sonnet for 3+
      const model = context.turnCount < 2
        ? "claude-haiku-4-5-20251001"
        : "claude-sonnet-4-20250514";

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: context.systemPrompt,
          messages: context.conversationHistory.map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Claude API error: ${res.status} ${err}`);
      }

      const data = await res.json();
      const responseText = data.content?.[0]?.text || "";

      return { responseText, model };
    });

    // Check for ESCALATE: prefix
    if (aiResponse.responseText.includes("ESCALATE:")) {
      const reason = aiResponse.responseText.replace("ESCALATE:", "").trim();
      await step.run("ai-requested-escalation", async () => {
        await handleEscalation(workspace_id, ticket_id, reason || "ai_unsure");
      });
      return { action: "escalated", reason: `ai_requested: ${reason}` };
    }

    // Step 5: Confidence check for draft-review decisions
    if (decision.action === "ai_draft_review") {
      await step.run("save-draft-for-review", async () => {
        const admin = createAdminClient();
        await admin.from("tickets").update({
          ai_draft: aiResponse.responseText,
          ai_confidence: 0.5,
          ai_tier: "review",
          ai_drafted_at: new Date().toISOString(),
        }).eq("id", ticket_id);

        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[AI Draft — Needs Review]\n\n${aiResponse.responseText}\n\nReason: ${decision.reason}`,
          author_type: "ai",
          visibility: "internal",
        });

        await handleEscalation(workspace_id, ticket_id, decision.reason);
      });
      return { action: "draft_for_review", reason: decision.reason };
    }

    // Step 5b: Execute AI workflow actions (e.g., marketing signup)
    const actionResult = await step.run("execute-actions", async () => {
      const admin = createAdminClient();
      const bodyLower = message_body.toLowerCase();

      // Check for marketing signup confirmation
      const signupKeywords = ["sign me up", "subscribe", "yes", "sign up", "opt in", "i'd love to", "please do", "go ahead"];
      const marketingKeywords = ["email", "sms", "marketing", "newsletter", "promo", "notification", "coupon"];
      const hasSignupIntent = signupKeywords.some(k => bodyLower.includes(k));
      const hasMarketingContext = marketingKeywords.some(k => bodyLower.includes(k));

      if (hasSignupIntent && hasMarketingContext) {
        // Get ticket to find customer
        const { data: ticket } = await admin
          .from("tickets")
          .select("customer_id")
          .eq("id", ticket_id)
          .single();

        if (ticket?.customer_id) {
          // Check existing marketing status first
          const { data: cust } = await admin
            .from("customers")
            .select("shopify_customer_id, email, phone, tags")
            .eq("id", ticket.customer_id)
            .single();

          // Check if already subscribed via Shopify tags or status
          const tags = (cust?.tags as string[]) || [];
          const alreadyEmailSubscribed = tags.some(t => t.toLowerCase().includes("email_subscriber") || t.toLowerCase().includes("accepts_marketing"));
          const alreadySmsSubscribed = tags.some(t => t.toLowerCase().includes("sms_subscriber"));

          // Prioritize SMS (higher value subscriber) — always try both unless already subscribed
          const channels: ("email" | "sms")[] = [];
          if (!alreadySmsSubscribed && cust?.phone) channels.push("sms");
          if (!alreadyEmailSubscribed) channels.push("email");

          if (channels.length === 0) {
            // Already subscribed to everything they asked for
            return { action: "marketing_already_subscribed", success: true };
          }

          const result = await subscribeToMarketing(workspace_id, ticket.customer_id, channels);

          if (result.success) {
            // Log the action
            await admin.from("ticket_messages").insert({
              ticket_id,
              direction: "outbound",
              body: `[System] Marketing subscription updated: ${channels.join(" + ")} — ${result.email_subscribed ? "Email: subscribed" : ""}${result.sms_subscribed ? " SMS: subscribed" : ""}${result.error ? ` (Note: ${result.error})` : ""}`,
              author_type: "system",
              visibility: "internal",
            });

            // Track workflow completion
            await admin.from("dashboard_notifications").insert({
              workspace_id,
              type: "system",
              title: "Marketing signup completed by AI",
              body: `Customer subscribed to ${channels.join(" + ")} marketing via AI conversation`,
              link: `/dashboard/tickets/${ticket_id}`,
              metadata: { ticket_id, channels, action: "marketing_signup" },
            });

            return { action: "marketing_signup", channels, success: true };
          }
          return { action: "marketing_signup", channels, success: false, error: result.error };
        }
      }
      return null;
    });

    // Step 6: Send response
    await step.run("send-response", async () => {
      const admin = createAdminClient();

      const { data: ticket } = await admin
        .from("tickets")
        .select("subject, email_message_id, customers(email)")
        .eq("id", ticket_id)
        .single();

      if (!ticket) return;

      const customerEmail = (ticket.customers as unknown as { email: string })?.email;
      const { data: ws } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", workspace_id).single();

      if (!context.sandbox && ws && !ws.sandbox_mode && customerEmail) {
        // Send real reply
        await sendTicketReply({
          workspaceId: workspace_id,
          toEmail: customerEmail,
          subject: ticket.subject ? `Re: ${ticket.subject}` : "Re: Your request",
          body: aiResponse.responseText,
          inReplyTo: ticket.email_message_id || null,
          agentName: "AI Agent",
          workspaceName: ws.name,
        });

        // Create outbound message
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: aiResponse.responseText,
          author_type: "ai",
          visibility: "external",
          ai_personalized: true,
        });

        // Update ticket — close if auto_resolve enabled (reply will reopen)
        await admin.from("tickets").update({
          status: context.autoResolve ? "closed" : "open",
          resolved_at: context.autoResolve ? new Date().toISOString() : undefined,
          ai_turn_count: context.turnCount + 1,
          last_ai_turn_at: new Date().toISOString(),
          handled_by: "AI Agent",
          auto_reply_at: null,
          pending_auto_reply: null,
        }).eq("id", ticket_id);
      } else {
        // Sandbox: save as internal note
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[AI Draft — Sandbox Mode — Turn ${context.turnCount + 1}]\n\n${aiResponse.responseText}`,
          author_type: "ai",
          visibility: "internal",
          ai_personalized: true,
        });

        await admin.from("tickets").update({
          status: context.autoResolve ? "closed" : "open",
          resolved_at: context.autoResolve ? new Date().toISOString() : undefined,
          ai_turn_count: context.turnCount + 1,
          last_ai_turn_at: new Date().toISOString(),
          handled_by: "AI Agent",
          auto_reply_at: null,
          pending_auto_reply: null,
        }).eq("id", ticket_id);
      }
    });

    return {
      action: "ai_responded",
      turn: context.turnCount + 1,
      model: aiResponse.model,
    };
  }
);
