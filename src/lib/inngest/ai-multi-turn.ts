// Multi-turn AI conversation handler
// Triggered when a customer replies to a ticket where AI is active

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleTicketContext } from "@/lib/ai-context";
import { routeInboundReply } from "@/lib/turn-router";
import { handleEscalation } from "@/lib/escalation";
import { sendTicketReply } from "@/lib/email";
import { subscribeToMarketing } from "@/lib/shopify-marketing";
import { matchPatterns } from "@/lib/pattern-matcher";
import { appstleSkipNextOrder, appstleUpdateBillingInterval } from "@/lib/appstle";
import { updateShippingAddress } from "@/lib/shopify-order-actions";

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
          .select("subject, channel, customers(email, first_name), handled_by")
          .eq("id", ticket_id)
          .single();

        const isAutoHandled = ticket?.handled_by === "AI Agent" || (ticket?.handled_by || "").startsWith("Workflow:");
        const firstName = (ticket?.customers as unknown as { first_name: string | null })?.first_name;

        // Only do AI closure if this was an AI or workflow handled ticket
        if (!isAutoHandled) {
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

        const channel = ticket?.channel || "email";
        // Use channel-specific sandbox setting from ai_channel_config
        const { data: channelCfg } = await admin
          .from("ai_channel_config")
          .select("sandbox")
          .eq("workspace_id", workspace_id)
          .eq("channel", channel)
          .single();
        const closeSandbox = channelCfg?.sandbox ?? ws?.sandbox_mode ?? true;

        if (!closeSandbox) {
          // Live mode — only send email if email channel
          if (channel === "email" && customerEmail) {
            const htmlClose = `<p>${closeMsg}</p>`;
            await sendTicketReply({
              workspaceId: workspace_id,
              toEmail: customerEmail,
              subject: ticket?.subject ? `Re: ${ticket.subject}` : "Re: Your request",
              body: htmlClose,
              inReplyTo: null,
              agentName: "AI Agent",
              workspaceName: ws?.name || "Support",
            });
          }

          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: `<p>${closeMsg}</p>`,
            author_type: "ai",
            visibility: "external",
          });

          // Close ticket — live reply went out
          await admin.from("tickets").update({
            status: "closed",
            resolved_at: new Date().toISOString(),
            auto_reply_at: null,
            pending_auto_reply: null,
          }).eq("id", ticket_id);
        } else {
          // Sandbox — internal note, don't close
          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: `[AI Draft — Sandbox Mode — Close]\n\n${closeMsg}`,
            author_type: "ai",
            visibility: "internal",
          });
        }
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

    // Step 1b: Smart pattern matching — check if a workflow should handle this first
    const patternResult = await step.run("check-patterns", async () => {
      const admin = createAdminClient();
      const { data: ticket } = await admin
        .from("tickets")
        .select("tags, ai_turn_count, subject")
        .eq("id", ticket_id)
        .single();

      // Only run pattern matching on first turn (turn 0) — follow-up turns stay with AI
      if (!ticket || (ticket.ai_turn_count || 0) > 0) return { matched: false };

      // Already has a smart tag — don't re-match
      const hasSmart = (ticket.tags as string[] || []).some(t => t.startsWith("smart:"));
      if (hasSmart) return { matched: false };

      try {
        const match = await matchPatterns(workspace_id, ticket.subject || "", message_body);
        if (match && match.autoTag) {
          // Add smart tag
          const tags = [...new Set([...(ticket.tags as string[] || []), match.autoTag])];
          await admin.from("tickets").update({ tags }).eq("id", ticket_id);

          // Check if there's a workflow for this tag
          const { data: workflow } = await admin
            .from("workflows")
            .select("id, name")
            .eq("workspace_id", workspace_id)
            .eq("trigger_tag", match.autoTag)
            .eq("enabled", true)
            .single();

          if (workflow) {
            // Set auto_reply_at so the workflow's cancel check doesn't block it
            const { data: wsDelays } = await admin.from("workspaces").select("response_delays").eq("id", workspace_id).single();
            const delays = (wsDelays?.response_delays || {}) as Record<string, number>;
            const delaySec = delays.chat || delays.email || 60;
            await admin.from("tickets").update({
              auto_reply_at: new Date(Date.now() + delaySec * 1000).toISOString(),
              handled_by: `Workflow: ${workflow.name}`,
            }).eq("id", ticket_id);

            // Fire the workflow
            await inngest.send({
              name: "workflow/execute",
              data: { workspace_id, ticket_id, trigger_tag: match.autoTag, channel: "chat" },
            });
            return { matched: true, tag: match.autoTag, workflow: workflow.name };
          }

          return { matched: true, tag: match.autoTag, workflow: null };
        }
      } catch {}

      return { matched: false };
    });

    if (patternResult.matched && (patternResult as { workflow?: string }).workflow) {
      return { action: "workflow_triggered", tag: (patternResult as { tag?: string }).tag, workflow: (patternResult as { workflow?: string }).workflow };
    }

    // Step 1c: Profile linking check (first message only, doesn't count as a turn)
    const linkResult = await step.run("check-profile-links", async () => {
      const admin = createAdminClient();
      const { data: ticket } = await admin
        .from("tickets")
        .select("profile_link_completed, customer_id")
        .eq("id", ticket_id)
        .single();

      if (ticket?.profile_link_completed || !ticket?.customer_id) return { action: "skip" };

      // Get customer info
      const { data: cust } = await admin
        .from("customers")
        .select("id, email, first_name, last_name")
        .eq("id", ticket.customer_id)
        .single();
      if (!cust?.first_name || !cust?.last_name) {
        await admin.from("tickets").update({ profile_link_completed: true }).eq("id", ticket_id);
        return { action: "skip" };
      }

      // Get existing link group (if any)
      const { data: existingLinks } = await admin
        .from("customer_links")
        .select("group_id")
        .eq("customer_id", cust.id);
      const groupId = existingLinks?.[0]?.group_id || null;

      // Get IDs already in this link group
      let alreadyLinkedIds: string[] = [];
      if (groupId) {
        const { data: groupMembers } = await admin
          .from("customer_links")
          .select("customer_id")
          .eq("group_id", groupId);
        alreadyLinkedIds = (groupMembers || []).map(m => m.customer_id);
      }

      // Find potential matches by name that are NOT already linked
      const { data: matches } = await admin
        .from("customers")
        .select("id, email")
        .eq("workspace_id", workspace_id)
        .eq("first_name", cust.first_name)
        .eq("last_name", cust.last_name)
        .neq("id", cust.id)
        .neq("email", cust.email)
        .limit(5);

      // Get previously rejected suggestions
      const { data: rejections } = await admin
        .from("customer_link_rejections")
        .select("rejected_customer_id")
        .eq("customer_id", cust.id);
      const rejectedIds = (rejections || []).map(r => r.rejected_customer_id);

      // Filter out already linked AND previously rejected
      const unlinked = (matches || []).filter(m => !alreadyLinkedIds.includes(m.id) && !rejectedIds.includes(m.id));
      if (unlinked.length === 0) {
        await admin.from("tickets").update({ profile_link_completed: true }).eq("id", ticket_id);
        return { action: "skip" };
      }

      return {
        action: "ask",
        matchEmail: unlinked[0].email,
        matchId: unlinked[0].id,
        allMatchEmails: unlinked.map(m => m.email),
        allMatchIds: unlinked.map(m => m.id),
        customerId: cust.id,
      };
    });

    // If we need to ask about profile linking
    if (linkResult.action === "ask") {
      // Check if we're already in a linking conversation (customer is responding to our question)
      const bodyLower = message_body.toLowerCase().trim();
      const isConfirming = /^(yes|yeah|yep|that's me|that is me|correct|yup|sure)/.test(bodyLower);
      const isDenying = /^(no|nope|not me|not mine|different|wrong)/.test(bodyLower);

      // Check if we already asked (look for the linking question in messages)
      const alreadyAsked = await step.run("check-link-asked", async () => {
        const admin = createAdminClient();
        const { data: msgs } = await admin
          .from("ticket_messages")
          .select("body")
          .eq("ticket_id", ticket_id)
          .eq("author_type", "ai")
          .order("created_at", { ascending: false })
          .limit(3);
        return (msgs || []).some(m => (m.body || "").includes("also your email"));
      });

      const matchId = (linkResult as { matchId?: string }).matchId;
      const matchEmail = (linkResult as { matchEmail?: string }).matchEmail;
      const linkCustomerId = (linkResult as { customerId?: string }).customerId;

      if (alreadyAsked && isConfirming && matchId && linkCustomerId) {
        // Customer confirmed — link the profiles
        await step.run("link-profiles", async () => {
          const admin = createAdminClient();
          const groupId = crypto.randomUUID();
          await admin.from("customer_links").insert([
            { customer_id: linkCustomerId, group_id: groupId, is_primary: true },
            { customer_id: matchId, group_id: groupId, is_primary: false },
          ]);
          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: "Perfect, I've linked your accounts so I can see your full order history. Let me help you with your question now!",
            author_type: "ai",
            visibility: "external",
          });
          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: `[System] Profiles linked: ${linkCustomerId} + ${matchId} (group: ${groupId})`,
            author_type: "system",
            visibility: "internal",
          });
          await admin.from("tickets").update({ profile_link_completed: true }).eq("id", ticket_id);
        });
        // Don't count this as a turn — return and let the next message trigger real support
        return { action: "profiles_linked" };
      } else if (alreadyAsked && isDenying) {
        // Customer said no — record rejection so we never offer this match again
        await step.run("reject-link", async () => {
          const admin = createAdminClient();
          await admin.from("tickets").update({ profile_link_completed: true }).eq("id", ticket_id);
          if (matchId && linkCustomerId) {
            await admin.from("customer_link_rejections").upsert({
              workspace_id,
              customer_id: linkCustomerId,
              rejected_customer_id: matchId,
            }, { onConflict: "customer_id,rejected_customer_id" });
          }
        });
        // Fall through to normal AI handling
      } else if (!alreadyAsked) {
        // Ask the customer about the match (doesn't count as a turn)
        await step.run("ask-about-link", async () => {
          const admin = createAdminClient();
          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: (() => {
              const allEmails = (linkResult as { allMatchEmails?: string[] }).allMatchEmails || [matchEmail || ""];
              const emailList = allEmails.map((e: string) => `<li style="word-break:break-all">${e}</li>`).join("");
              const plural = allEmails.length > 1;
              return `I'm looking into that for you! By the way, I noticed we might have multiple profiles for you in our system. ${plural ? "Do these emails" : "Does this email"} also belong to you?<ul>${emailList}</ul>`;
            })(),
            author_type: "ai",
            visibility: "external",
          });
        });
        return { action: "asked_about_link" };
      }
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

      // Check for marketing signup / discount / coupon apply confirmation
      const confirmKeywords = ["sign me up", "subscribe", "yes", "sign up", "opt in", "i'd love to", "please do", "go ahead", "yes please", "yeah", "apply", "add it", "do it", "sure"];
      const contextKeywords = ["email", "sms", "marketing", "newsletter", "promo", "notification", "coupon", "discount", "deal", "both", "family", "subscription", "code"];
      const hasConfirmIntent = confirmKeywords.some(k => bodyLower.includes(k));
      const hasContext = contextKeywords.some(k => bodyLower.includes(k));

      if (!hasConfirmIntent || !hasContext) return null;

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

      // If already subscribed to both → find the right coupon from mappings
      if (emailSubscribed && smsSubscribed) {
        // Look up the best coupon for this use case + customer tier
        const { data: wsSettings } = await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspace_id).single();
        const vipThreshold = wsSettings?.vip_retention_threshold || 85;
        const { data: custFull } = await admin.from("customers").select("retention_score").eq("id", cust.id).single();
        const isVip = (custFull?.retention_score || 0) >= vipThreshold;

        const { data: coupons } = await admin
          .from("coupon_mappings")
          .select("code, use_cases, customer_tier, value_type, value, summary")
          .eq("workspace_id", workspace_id)
          .eq("ai_enabled", true);

        // Find coupon matching "discount_request" use case and customer tier
        const eligible = (coupons || []).filter(c =>
          c.use_cases.includes("discount_request") &&
          (c.customer_tier === "all" || (c.customer_tier === "vip" && isVip) || (c.customer_tier === "non_vip" && !isVip))
        );
        const couponCode = eligible.length > 0 ? eligible[0].code : null;

        if (!couponCode) {
          // No mapped coupon available
          return { action: "no_coupon_available" };
        }

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

          // Check for existing discounts — remove them before applying SHOPCX
          try {
            canApplyToSub = true;

            const { data: ws } = await admin
              .from("workspaces")
              .select("appstle_api_key_encrypted")
              .eq("id", workspace_id)
              .single();

            if (ws?.appstle_api_key_encrypted) {
              const { decrypt } = await import("@/lib/crypto");
              const apiKey = decrypt(ws.appstle_api_key_encrypted);

              // Check raw contract for existing discounts and remove them
              const rawRes = await fetch(
                `https://subscription-admin.appstle.com/api/external/v2/contract-raw-response?contractId=${subContractId}&api_key=${apiKey}`,
                { headers: { "X-API-Key": apiKey } }
              );
              if (rawRes.ok) {
                const rawText = await rawRes.text();
                const nodesMatch = rawText.match(/"discounts"[\s\S]*?"nodes"\s*:\s*\[([\s\S]*?)\]/);
                if (nodesMatch && nodesMatch[1].trim()) {
                  try {
                    const nodes = JSON.parse(`[${nodesMatch[1]}]`);
                    // Remove any existing discounts before applying SHOPCX
                    for (const node of nodes) {
                      if (node.id) {
                        const encodedId = encodeURIComponent(node.id);
                        await fetch(
                          `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${subContractId}&discountId=${encodedId}&api_key=${apiKey}`,
                          { method: "PUT", headers: { "X-API-Key": apiKey } }
                        );
                      }
                    }
                  } catch {}
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
          body: `[System] Customer already subscribed to email + SMS marketing. Provided discount code ${couponCode}.${subNote}`,
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

              // Apply discount code
              const applyRes = await fetch(
                `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-apply-discount?contractId=${subContractId}&discountCode=${couponCode}&api_key=${apiKey}`,
                { method: "PUT", headers: { "X-API-Key": apiKey } }
              );

              // Verify no duplicate codes — check raw contract for extra discounts
              if (applyRes.ok) {
                const verifyRes = await fetch(
                  `https://subscription-admin.appstle.com/api/external/v2/contract-raw-response?contractId=${subContractId}&api_key=${apiKey}`,
                  { headers: { "X-API-Key": apiKey } }
                );
                if (verifyRes.ok) {
                  const rawText = await verifyRes.text();
                  // Parse discount nodes from raw response
                  const nodesMatch = rawText.match(/"discounts"[\s\S]*?"nodes"\s*:\s*\[([\s\S]*?)\]/);
                  if (nodesMatch && nodesMatch[1].trim()) {
                    try {
                      const nodes = JSON.parse(`[${nodesMatch[1]}]`);
                      // If more than one discount, remove any that aren't the one we just applied
                      if (nodes.length > 1) {
                        for (const node of nodes) {
                          if (node.title && node.title.toUpperCase() !== couponCode.toUpperCase() && node.id) {
                            const encodedId = encodeURIComponent(node.id);
                            await fetch(
                              `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${subContractId}&discountId=${encodedId}&api_key=${apiKey}`,
                              { method: "PUT", headers: { "X-API-Key": apiKey } }
                            );
                          }
                        }
                      }
                    } catch {}
                  }
                }
              }

              await admin.from("ticket_messages").insert({
                ticket_id,
                direction: "outbound",
                body: `[System] Discount code ${couponCode} applied to subscription contract ${subContractId} via Appstle.`,
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

    // Step 5c: Execute new AI workflow actions (return, address, subscription, order status)
    await step.run("execute-workflow-actions", async () => {
      const admin = createAdminClient();
      const bodyLower = message_body.toLowerCase();

      // Get ticket + customer
      const { data: ticket } = await admin
        .from("tickets")
        .select("customer_id, tags")
        .eq("id", ticket_id)
        .single();
      if (!ticket?.customer_id) return null;

      const { data: cust } = await admin
        .from("customers")
        .select("id, shopify_customer_id")
        .eq("id", ticket.customer_id)
        .single();
      if (!cust) return null;

      // Check enabled workflows for this workspace
      const { data: workflows } = await admin
        .from("ai_workflows")
        .select("trigger_intent, match_patterns")
        .eq("workspace_id", workspace_id)
        .eq("enabled", true);

      const enabledIntents = new Set((workflows || []).map(w => w.trigger_intent));

      // --- Return Request: detect return/exchange intent, tag + escalate ---
      if (enabledIntents.has("return_request")) {
        const returnKeywords = ["return", "exchange", "wrong item", "damaged", "broken", "not what i ordered", "send back", "send it back"];
        const hasReturnIntent = returnKeywords.some(k => bodyLower.includes(k));

        if (hasReturnIntent) {
          const tags = [...new Set([...(ticket.tags || []), "return-request"])];
          await admin.from("tickets").update({ tags }).eq("id", ticket_id);

          await admin.from("ticket_messages").insert({
            ticket_id,
            direction: "outbound",
            body: `[System] Return/exchange request detected. Tagged ticket with "return-request". AI will gather details before escalating.`,
            author_type: "system",
            visibility: "internal",
          });

          return { action: "return_request_tagged" };
        }
      }

      // --- Address Change: detect address update confirmation with address in message ---
      if (enabledIntents.has("address_change")) {
        const addressKeywords = ["change address", "update address", "new address", "change my address", "ship to", "shipping address"];
        const hasAddressIntent = addressKeywords.some(k => bodyLower.includes(k));

        if (hasAddressIntent) {
          // Check if the customer's most recent order is unfulfilled
          const { data: recentOrder } = await admin
            .from("orders")
            .select("id, order_number, fulfillment_status, shopify_order_id")
            .eq("workspace_id", workspace_id)
            .eq("customer_id", cust.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (recentOrder && (!recentOrder.fulfillment_status || recentOrder.fulfillment_status === "unfulfilled")) {
            // Parse address from the AI response (the AI should have asked and customer provided)
            // We'll note the intent; actual address parsing happens when AI confirms with customer
            await admin.from("ticket_messages").insert({
              ticket_id,
              direction: "outbound",
              body: `[System] Address change requested for order #${recentOrder.order_number || recentOrder.id} (unfulfilled). AI will confirm new address with customer before updating.`,
              author_type: "system",
              visibility: "internal",
            });

            return { action: "address_change_detected", orderId: recentOrder.id, canUpdate: true };
          } else if (recentOrder) {
            await admin.from("ticket_messages").insert({
              ticket_id,
              direction: "outbound",
              body: `[System] Address change requested but most recent order #${recentOrder.order_number || recentOrder.id} is already ${recentOrder.fulfillment_status || "fulfilled"}. AI will inform customer.`,
              author_type: "system",
              visibility: "internal",
            });

            return { action: "address_change_detected", canUpdate: false };
          }
        }

        // Detect address confirmation with actual address data (follow-up turn)
        // Look for patterns like "123 Main St" or structured address
        const addressLinePattern = /\d+\s+\w+\s+(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|pl|place)\b/i;
        const hasAddressData = addressLinePattern.test(message_body);
        const confirmKeywords = ["yes", "correct", "that's right", "update it", "please update", "go ahead"];
        const isConfirming = confirmKeywords.some(k => bodyLower.includes(k));

        if (hasAddressData || isConfirming) {
          // Check previous messages for address context
          const { data: prevMsgs } = await admin
            .from("ticket_messages")
            .select("body, author_type")
            .eq("ticket_id", ticket_id)
            .eq("visibility", "internal")
            .eq("author_type", "system")
            .order("created_at", { ascending: false })
            .limit(5);

          const hasAddressNote = prevMsgs?.some(m => (m.body || "").includes("Address change requested") && (m.body || "").includes("unfulfilled"));

          if (hasAddressNote && hasAddressData) {
            // Get the unfulfilled order
            const { data: order } = await admin
              .from("orders")
              .select("shopify_order_id, order_number")
              .eq("workspace_id", workspace_id)
              .eq("customer_id", cust.id)
              .or("fulfillment_status.is.null,fulfillment_status.eq.unfulfilled")
              .order("created_at", { ascending: false })
              .limit(1)
              .single();

            if (order?.shopify_order_id) {
              // Try to parse address components from message
              // This is a best-effort parse — the AI response will confirm success/failure
              const lines = message_body.split(/[,\n]/).map(l => l.trim()).filter(Boolean);
              if (lines.length >= 2) {
                const result = await updateShippingAddress(workspace_id, order.shopify_order_id, {
                  address1: lines[0],
                  city: lines[1] || "",
                  province: lines[2] || "",
                  zip: lines[3] || "",
                  country: lines[4] || "US",
                });

                await admin.from("ticket_messages").insert({
                  ticket_id,
                  direction: "outbound",
                  body: `[System] Shipping address update for order #${order.order_number}: ${result.success ? "Success" : `Failed — ${result.error}`}`,
                  author_type: "system",
                  visibility: "internal",
                });

                return { action: "address_updated", success: result.success };
              }
            }
          }
        }
      }

      // --- Subscription Skip: detect skip confirmation ---
      if (enabledIntents.has("subscription_change")) {
        const skipKeywords = ["skip", "skip next", "skip my next", "hold next"];
        const swapKeywords = ["swap", "switch", "change product", "switch flavor", "different flavor"];
        const frequencyKeywords = ["change frequency", "every 2 weeks", "every month", "every week", "bi-weekly", "monthly", "weekly"];
        const confirmKeywords = ["yes", "please", "go ahead", "do it", "confirm", "sure", "yeah"];

        const hasSkipIntent = skipKeywords.some(k => bodyLower.includes(k));
        const hasSwapIntent = swapKeywords.some(k => bodyLower.includes(k));
        const hasFrequencyIntent = frequencyKeywords.some(k => bodyLower.includes(k));
        const isConfirming = confirmKeywords.some(k => bodyLower.includes(k));

        // Get active subscription
        const { data: activeSub } = await admin
          .from("subscriptions")
          .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count")
          .eq("workspace_id", workspace_id)
          .eq("customer_id", cust.id)
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (activeSub?.shopify_contract_id) {
          // Skip next order
          if (hasSkipIntent && (isConfirming || hasSkipIntent)) {
            const result = await appstleSkipNextOrder(workspace_id, activeSub.shopify_contract_id);

            await admin.from("ticket_messages").insert({
              ticket_id,
              direction: "outbound",
              body: `[System] Subscription skip for contract ${activeSub.shopify_contract_id}: ${result.success ? "Next order skipped successfully" : `Failed — ${result.error}`}`,
              author_type: "system",
              visibility: "internal",
            });

            if (result.success) {
              await admin.from("dashboard_notifications").insert({
                workspace_id,
                type: "system",
                title: "Subscription order skipped by AI",
                body: `Customer's next subscription order was skipped via AI conversation`,
                link: `/dashboard/tickets/${ticket_id}`,
                metadata: { ticket_id, contract_id: activeSub.shopify_contract_id, action: "subscription_skip" },
              });
            }

            return { action: "subscription_skip", success: result.success };
          }

          // Change frequency
          if (hasFrequencyIntent) {
            // Parse desired frequency
            let interval: "WEEK" | "MONTH" = "MONTH";
            let intervalCount = 1;

            if (bodyLower.includes("every 2 weeks") || bodyLower.includes("bi-weekly") || bodyLower.includes("biweekly")) {
              interval = "WEEK"; intervalCount = 2;
            } else if (bodyLower.includes("every week") || bodyLower.includes("weekly")) {
              interval = "WEEK"; intervalCount = 1;
            } else if (bodyLower.includes("every month") || bodyLower.includes("monthly")) {
              interval = "MONTH"; intervalCount = 1;
            } else if (bodyLower.includes("every 2 months")) {
              interval = "MONTH"; intervalCount = 2;
            } else if (bodyLower.includes("every 3 months") || bodyLower.includes("quarterly")) {
              interval = "MONTH"; intervalCount = 3;
            }

            const result = await appstleUpdateBillingInterval(
              workspace_id,
              activeSub.shopify_contract_id,
              interval,
              intervalCount,
            );

            await admin.from("ticket_messages").insert({
              ticket_id,
              direction: "outbound",
              body: `[System] Subscription frequency update to every ${intervalCount} ${interval.toLowerCase()}(s) for contract ${activeSub.shopify_contract_id}: ${result.success ? "Success" : `Failed — ${result.error}`}`,
              author_type: "system",
              visibility: "internal",
            });

            if (result.success) {
              await admin.from("dashboard_notifications").insert({
                workspace_id,
                type: "system",
                title: "Subscription frequency changed by AI",
                body: `Customer's subscription changed to every ${intervalCount} ${interval.toLowerCase()}(s)`,
                link: `/dashboard/tickets/${ticket_id}`,
                metadata: { ticket_id, contract_id: activeSub.shopify_contract_id, action: "subscription_frequency_change" },
              });
            }

            return { action: "subscription_frequency_change", success: result.success };
          }

          // Swap product — just note intent, product swap requires variant selection
          if (hasSwapIntent) {
            await admin.from("ticket_messages").insert({
              ticket_id,
              direction: "outbound",
              body: `[System] Product swap requested for subscription contract ${activeSub.shopify_contract_id}. AI will confirm product selection with customer. Current items: ${JSON.stringify((activeSub.items as { title: string }[] | null)?.map(i => i.title))}`,
              author_type: "system",
              visibility: "internal",
            });

            return { action: "subscription_swap_detected" };
          }
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

      // AI channel sandbox setting is authoritative for AI responses
      // finalContext.sandbox comes from ai_channel_config.sandbox for this channel
      const isSandbox = finalContext.sandbox;
      const htmlBody = toHtmlParagraphs(aiResponse.responseText);

      if (!isSandbox) {
        // Live mode — send via appropriate channel (email only sends on email channel)
        if (finalContext.channel === "email" && customerEmail) {
          await sendTicketReply({
            workspaceId: workspace_id,
            toEmail: customerEmail,
            subject: ticket.subject ? `Re: ${ticket.subject}` : "Re: Your request",
            body: htmlBody,
            inReplyTo: ticket.email_message_id || null,
            agentName: "AI Agent",
            workspaceName: ws?.name || "Support",
          });
        }
        // Chat, help_center, sms, meta — no email sent, message just appears in the channel

        // Create external message (visible to customer in widget/thread)
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: htmlBody,
          author_type: "ai",
          visibility: "external",
          ai_personalized: true,
        });
      } else {
        // Sandbox: save as internal note (not visible to customer on any channel)
        await admin.from("ticket_messages").insert({
          ticket_id,
          direction: "outbound",
          body: `[AI Draft — Sandbox Mode — Turn ${finalContext.turnCount + 1}]\n\n${aiResponse.responseText}`,
          author_type: "ai",
          visibility: "internal",
          ai_personalized: true,
        });
      }

      // Update ticket — only close if live reply went out (not sandbox)
      const shouldClose = !isSandbox && finalContext.autoResolve;
      await admin.from("tickets").update({
        status: shouldClose ? "closed" : "open",
        resolved_at: shouldClose ? new Date().toISOString() : undefined,
        ai_turn_count: finalContext.turnCount + 1,
        last_ai_turn_at: new Date().toISOString(),
        handled_by: "AI Agent",
        auto_reply_at: null,
        pending_auto_reply: null,
      }).eq("id", ticket_id);
    });

    return {
      action: "ai_responded",
      turn: finalContext.turnCount + 1,
      model: aiResponse.model,
    };
  }
);
