// Multi-turn AI conversation handler
// Triggered when a customer replies to a ticket where AI is active

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleTicketContext } from "@/lib/ai-context";
import { routeInboundReply } from "@/lib/turn-router";
import { handleEscalation } from "@/lib/escalation";
import { sendTicketReply } from "@/lib/email";
import { subscribeToMarketing } from "@/lib/shopify-marketing";

// Convert plain text AI response to light HTML paragraphs
function toHtmlParagraphs(text: string): string {
  return text
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

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
          const htmlClose = `<p>${closeMsg}</p>`;
          await sendTicketReply({
            workspaceId: workspace_id,
            toEmail: customerEmail,
            subject: ticket?.subject ? `Re: ${ticket.subject}` : "Re: Your request",
            body: htmlClose,
            inReplyTo: null,
            agentName: "AI Agent",
            workspaceName: ws.name,
          });

          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: htmlClose,
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

    // Step 2b: KB gap check — if no KB chunks or macros matched AND it's a question, don't wing it
    // Skip gap check for action confirmations (yes, sign me up, etc.)
    const isActionConfirmation = /^(yes|yeah|sure|ok|please|go ahead|sign me up|do it|absolutely)/i.test(message_body.trim());
    if (!isActionConfirmation && context.ragContext.chunks.length === 0 && context.ragContext.macros.length === 0) {
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

    // Check if agent cancelled OR new messages arrived during delay
    const postDelayCheck = await step.run("check-after-delay", async () => {
      const admin = createAdminClient();
      const { data: ticket } = await admin.from("tickets").select("assigned_to, agent_intervened").eq("id", ticket_id).single();

      if (ticket?.assigned_to || ticket?.agent_intervened) {
        return { cancelled: true, newMessages: false };
      }

      // Check if customer sent more messages during the delay
      const { data: recentInbound } = await admin
        .from("ticket_messages")
        .select("body")
        .eq("ticket_id", ticket_id)
        .eq("direction", "inbound")
        .eq("visibility", "external")
        .order("created_at", { ascending: false })
        .limit(3);

      const latest = (recentInbound || [])[0]?.body?.trim();
      const hasNew = latest && latest !== message_body.trim();

      return { cancelled: false, newMessages: !!hasNew };
    });

    if (postDelayCheck.cancelled) {
      return { action: "cancelled", reason: "agent_intervened" };
    }

    // If new messages arrived during delay, re-assemble context with all messages
    let finalContext = context;
    if (postDelayCheck.newMessages) {
      finalContext = await step.run("reassemble-with-new-messages", async () => {
        return assembleTicketContext(workspace_id, ticket_id);
      });
    }

    // Step 4: Generate response
    const aiResponse = await step.run("generate-response", async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("No ANTHROPIC_API_KEY");

      // Use Haiku for turns 1-2, Sonnet for 3+
      const model = finalContext.turnCount < 2
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
          system: finalContext.systemPrompt,
          messages: finalContext.conversationHistory.map(m => ({
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

    // Step 5b: Execute AI workflow actions (marketing signup OR discount code)
    await step.run("execute-actions", async () => {
      const admin = createAdminClient();
      const bodyLower = message_body.toLowerCase();

      // Check for marketing signup / discount confirmation
      const signupKeywords = ["sign me up", "subscribe", "yes", "sign up", "opt in", "i'd love to", "please do", "go ahead", "yes please", "yeah"];
      const marketingKeywords = ["email", "sms", "marketing", "newsletter", "promo", "notification", "coupon", "discount", "deal", "both"];
      const hasSignupIntent = signupKeywords.some(k => bodyLower.includes(k));
      const hasMarketingContext = marketingKeywords.some(k => bodyLower.includes(k));

      if (!hasSignupIntent || !hasMarketingContext) return null;

      // Get ticket + customer
      const { data: ticket } = await admin
        .from("tickets")
        .select("customer_id")
        .eq("id", ticket_id)
        .single();
      if (!ticket?.customer_id) return null;

      const { data: cust } = await admin
        .from("customers")
        .select("id, shopify_customer_id, email, phone, email_marketing_status, sms_marketing_status")
        .eq("id", ticket.customer_id)
        .single();
      if (!cust) return null;

      const emailSubscribed = cust.email_marketing_status === "subscribed";
      const smsSubscribed = cust.sms_marketing_status === "subscribed";

      // If already subscribed to both → give discount code
      if (emailSubscribed && smsSubscribed) {
        // Check if they have an active subscription we can apply the coupon to
        const { data: activeSubs } = await admin
          .from("subscriptions")
          .select("id, shopify_contract_id, status, items")
          .eq("workspace_id", workspace_id)
          .eq("customer_id", cust.id)
          .eq("status", "active")
          .limit(1);

        let canApplyToSub = false;
        let subContractId: string | null = null;

        if (activeSubs?.length && activeSubs[0].shopify_contract_id) {
          subContractId = activeSubs[0].shopify_contract_id;

          // Check Appstle for existing discount on subscription
          try {
            canApplyToSub = true;

            // Call Appstle to check subscription details for existing discounts
            const { data: ws } = await admin
              .from("workspaces")
              .select("appstle_api_key_encrypted, shopify_myshopify_domain")
              .eq("id", workspace_id)
              .single();

            if (ws?.appstle_api_key_encrypted && cust.shopify_customer_id) {
              const { decrypt } = await import("@/lib/crypto");
              const apiKey = decrypt(ws.appstle_api_key_encrypted);
              const detailsRes = await fetch(
                `https://subscription-admin.appstle.com/api/external/v2/customer-subscription-details?customerShopifyId=${cust.shopify_customer_id}`,
                { headers: { "X-API-Key": apiKey } }
              );
              if (detailsRes.ok) {
                const details = await detailsRes.json();
                // Check if any active contract has a discount code
                const contracts = details?.subscriptionContracts || details?.contracts || [];
                for (const contract of contracts) {
                  if (String(contract.contractId || contract.id) === subContractId) {
                    const hasDiscount = contract.discountCode || contract.appliedDiscount || (contract.discountCodes && contract.discountCodes.length > 0);
                    if (hasDiscount) canApplyToSub = false;
                    break;
                  }
                }
              }
            }
          } catch {
            canApplyToSub = false;
          }
        }

        // Log the discount code action
        const subNote = canApplyToSub && subContractId
          ? " Offered to apply to active subscription."
          : activeSubs?.length
            ? " Subscription already has a discount applied."
            : " No active subscription to apply coupon to.";

        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[System] Customer already subscribed to email + SMS marketing. Provided discount code FAMILY.${subNote}`,
          author_type: "system",
          visibility: "internal",
        });

        // If we can apply to subscription, do it via Appstle
        if (canApplyToSub && subContractId) {
          try {
            const { data: ws } = await admin
              .from("workspaces")
              .select("appstle_api_key_encrypted")
              .eq("id", workspace_id)
              .single();
            if (ws?.appstle_api_key_encrypted) {
              const { decrypt } = await import("@/lib/crypto");
              const apiKey = decrypt(ws.appstle_api_key_encrypted);
              await fetch(
                `https://subscription-admin.appstle.com/api/external/v2/subscription-discount-apply?contractId=${subContractId}&discountCode=FAMILY`,
                { method: "POST", headers: { "X-API-Key": apiKey } }
              );
              await admin.from("ticket_messages").insert({
                ticket_id,
                direction: "outbound",
                body: `[System] Discount code FAMILY applied to subscription contract ${subContractId} via Appstle.`,
                author_type: "system",
                visibility: "internal",
              });
            }
          } catch {}
        }

        return { action: "discount_code_given", alreadySubscribed: true, canApplyToSub };
      }

      // Not fully subscribed → sign them up
      const channels: ("email" | "sms")[] = [];
      if (!smsSubscribed && cust.phone) channels.push("sms");
      if (!emailSubscribed) channels.push("email");

      if (channels.length === 0) return { action: "marketing_already_subscribed", success: true };

      const result = await subscribeToMarketing(workspace_id, cust.id, channels);

      if (result.success) {
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[System] Marketing subscription updated: ${channels.join(" + ")} — ${result.email_subscribed ? "Email: subscribed " : ""}${result.sms_subscribed ? "SMS: subscribed " : ""}${result.error ? `(Note: ${result.error})` : ""}`,
          author_type: "system",
          visibility: "internal",
        });

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

      if (!finalContext.sandbox && ws && !ws.sandbox_mode && customerEmail) {
        // Convert to HTML paragraphs for email
        const htmlBody = toHtmlParagraphs(aiResponse.responseText);

        // Send real reply
        await sendTicketReply({
          workspaceId: workspace_id,
          toEmail: customerEmail,
          subject: ticket.subject ? `Re: ${ticket.subject}` : "Re: Your request",
          body: htmlBody,
          inReplyTo: ticket.email_message_id || null,
          agentName: "AI Agent",
          workspaceName: ws.name,
        });

        // Create outbound message (store HTML for display)
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: htmlBody,
          author_type: "ai",
          visibility: "external",
          ai_personalized: true,
        });

        // Update ticket — close if auto_resolve enabled (reply will reopen)
        await admin.from("tickets").update({
          status: finalContext.autoResolve ? "closed" : "open",
          resolved_at: finalContext.autoResolve ? new Date().toISOString() : undefined,
          ai_turn_count: finalContext.turnCount + 1,
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
          body: `[AI Draft — Sandbox Mode — Turn ${finalContext.turnCount + 1}]\n\n${aiResponse.responseText}`,
          author_type: "ai",
          visibility: "internal",
          ai_personalized: true,
        });

        await admin.from("tickets").update({
          status: finalContext.autoResolve ? "closed" : "open",
          resolved_at: finalContext.autoResolve ? new Date().toISOString() : undefined,
          ai_turn_count: finalContext.turnCount + 1,
          last_ai_turn_at: new Date().toISOString(),
          handled_by: "AI Agent",
          auto_reply_at: null,
          pending_auto_reply: null,
        }).eq("id", ticket_id);
      }
    });

    return {
      action: "ai_responded",
      turn: finalContext.turnCount + 1,
      model: aiResponse.model,
    };
  }
);
