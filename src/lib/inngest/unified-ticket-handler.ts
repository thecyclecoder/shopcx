/**
 * Unified Ticket Handler
 *
 * Single entry point for ALL inbound messages across all channels.
 * Pipeline: resolve customer → check linking → check state → classify intent → confidence gate → route
 *
 * Priority: Account linking → Journey → Workflow → Macro → KB article → Escalate
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { assembleTicketContext } from "@/lib/ai-context";
import { retrieveContext } from "@/lib/rag";
import { sendTicketReply } from "@/lib/email";
import { addTicketTag } from "@/lib/ticket-tags";
import { markFirstTouch } from "@/lib/first-touch";
import { buildCombinedEmailJourney } from "@/lib/email-journey-builder";

// ── Types ──

interface InboundEvent {
  workspace_id: string;
  ticket_id: string;
  message_body: string;
  channel: string;
  is_new_ticket: boolean;
}

// ── Helpers ──

function toHtmlParagraphs(text: string): string {
  return text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

function postInternalNote(admin: ReturnType<typeof createAdminClient>, ticketId: string, note: string) {
  return admin.from("ticket_messages").insert({
    ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system", body: note,
  });
}

async function getChannelConfig(admin: ReturnType<typeof createAdminClient>, workspaceId: string, channel: string) {
  const { data } = await admin.from("ai_channel_config")
    .select("enabled, confidence_threshold, auto_resolve, sandbox, ticket_status_after_ai")
    .eq("workspace_id", workspaceId).eq("channel", channel).single();
  return {
    enabled: data?.enabled ?? true,
    confidence_threshold: data?.confidence_threshold ?? 70,
    auto_resolve: data?.auto_resolve ?? false,
    sandbox: data?.sandbox ?? true,
    ticket_status_after_ai: data?.ticket_status_after_ai || "closed",
  };
}

function isAccountRelatedIntent(intent: string): boolean {
  return ["order", "subscription", "cancel", "billing", "refund", "return", "exchange", "address", "payment", "account", "delivery", "shipping", "tracking"]
    .some(k => intent.toLowerCase().includes(k));
}

// ── AI Calls ──

async function callClaude(prompt: string, maxTokens = 200): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "{}";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return (data.content?.[0] as { text: string })?.text?.trim() || "";
}

async function classifyIntent(messageBody: string, customerCtx: string, history: string, handlerNames: string): Promise<{ intent: string; confidence: number; reasoning: string; handler_type: string; handler_name: string }> {
  const raw = await callClaude(`You are an intent classifier for customer support. Given the message, customer context, and available handlers, identify the intent.

Customer message: "${messageBody}"
${customerCtx ? `Customer context:\n${customerCtx}\n` : "No customer found."}
${history ? `Conversation:\n${history}\n` : ""}
Available handlers:\n${handlerNames || "None"}

Return JSON only: { "intent": "brief label", "confidence": 0-100, "reasoning": "one sentence", "handler_type": "journey|workflow|macro|none", "handler_name": "name or null" }`);

  try {
    return JSON.parse(raw.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
  } catch {
    return { intent: "unknown", confidence: 0, reasoning: "parse error", handler_type: "none", handler_name: "" };
  }
}

async function generateClarification(messageBody: string, intent: string, confidence: number, channel: string): Promise<string> {
  const short = ["chat", "sms", "meta_dm"].includes(channel);
  const raw = await callClaude(`You are a customer support agent (never reveal AI). Customer sent: "${messageBody}". Best guess: "${intent}" (${confidence}% confidence). Ask ONE specific clarifying question. ${short ? "Max 20 words." : "Max 30 words."} Return only the question.`, 80);
  return raw || "Could you tell me a bit more about what you need help with?";
}

async function personalizeMacro(content: string, customerCtx: string, messageBody: string, channel: string): Promise<string> {
  const short = ["chat", "sms", "meta_dm"].includes(channel);
  const raw = await callClaude(`Lightly personalize this support response. Insert customer name/order details where natural. Do NOT make it longer or more verbose. ${short ? "Keep very short." : ""}

Original: ${content}
Customer message: "${messageBody}"
${customerCtx ? `Customer: ${customerCtx.slice(0, 300)}` : ""}

Return only the personalized response. No markdown.`, 300);
  return raw || content;
}

async function craftKBResponse(article: string, title: string, messageBody: string, channel: string): Promise<string> {
  const short = ["chat", "sms", "meta_dm"].includes(channel);
  const raw = await callClaude(`Answer the customer's question using ONLY this KB article. Extract the relevant answer. ${short ? "Max 2 sentences." : "Max 3-4 sentences."} No markdown. Be a human agent.

Question: "${messageBody}"
KB "${title}": ${article.slice(0, 1500)}

Return only your response.`, 200);
  return raw || article.slice(0, 500);
}

// ── Send Response ──

async function sendResponse(admin: ReturnType<typeof createAdminClient>, workspaceId: string, ticketId: string, channel: string, message: string) {
  const html = toHtmlParagraphs(message);
  const { data: ws } = await admin.from("workspaces").select("sandbox_mode").eq("id", workspaceId).single();
  const config = await getChannelConfig(admin, workspaceId, channel);
  const sandbox = ws?.sandbox_mode || config.sandbox;

  if (sandbox) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "ai", body: `[AI Draft] ${html}`,
    });
  } else {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId, direction: "outbound", visibility: "external", author_type: "ai", body: html,
    });
    if (channel === "email") {
      const { data: ticket } = await admin.from("tickets")
        .select("subject, customers(email)")
        .eq("id", ticketId).single();
      const email = (ticket?.customers as unknown as { email: string })?.email;
      if (email) {
        const { data: wsName } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();
        await sendTicketReply({
          workspaceId, toEmail: email, subject: ticket?.subject || "Re: Your request",
          body: html, inReplyTo: ticketId, agentName: "Support", workspaceName: wsName?.name || "",
        });
      }
    }
  }
}

// ── Main Handler ──

export const unifiedTicketHandler = inngest.createFunction(
  {
    id: "unified-ticket-handler",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.ticket_id" }],
    triggers: [{ event: "ticket/inbound-message" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ticket_id, message_body, channel, is_new_ticket } = event.data as InboundEvent;
    const admin = createAdminClient();

    // ── Step 1: Resolve state ──
    const state = await step.run("resolve-state", async () => {
      const { data: ticket } = await admin.from("tickets")
        .select("customer_id, channel, ai_clarification_turn, ai_detected_intent, agent_intervened")
        .eq("id", ticket_id).single();
      if (!ticket) throw new Error("Ticket not found");

      let customer: { id: string; email: string; first_name: string | null; shopify_customer_id: string | null } | null = null;
      if (ticket.customer_id) {
        const { data } = await admin.from("customers")
          .select("id, email, first_name, shopify_customer_id")
          .eq("id", ticket.customer_id).single();
        customer = data;
      }

      if (customer && is_new_ticket) {
        await postInternalNote(admin, ticket_id, `[System] Customer resolved: ${customer.first_name || ""} (${customer.email})`);
      } else if (!customer && is_new_ticket) {
        await postInternalNote(admin, ticket_id, `[System] No customer match found`);
      }

      return {
        hasCustomer: !!customer,
        customerId: customer?.id || null,
        shopifyCustomerId: customer?.shopify_customer_id || null,
        ch: ticket.channel || channel,
        clarifyTurn: ticket.ai_clarification_turn || 0,
        agentIntervened: !!ticket.agent_intervened,
      };
    });

    if (state.agentIntervened) return { status: "skipped", reason: "agent_intervened" };

    // ── Step 2: Check for potential account linking (supercedes everything) ──
    if (state.hasCustomer && is_new_ticket) {
      const needsLinking = await step.run("check-account-linking", async () => {
        const { data: links } = await admin.from("customer_links")
          .select("group_id").eq("customer_id", state.customerId!);
        if (links?.length) return false; // Already linked

        // Check for potential matches by email domain, phone, name
        const { data: customer } = await admin.from("customers")
          .select("email, phone, first_name, last_name")
          .eq("id", state.customerId!).single();
        if (!customer) return false;

        // Look for other customers with same phone or similar email
        const conditions: string[] = [];
        if (customer.phone) conditions.push(`phone.eq.${customer.phone}`);
        const emailParts = customer.email?.split("@");
        if (emailParts?.[0]) conditions.push(`email.ilike.${emailParts[0]}@%`);

        if (!conditions.length) return false;

        const { data: potentialMatches } = await admin.from("customers")
          .select("id")
          .eq("workspace_id", workspace_id)
          .neq("id", state.customerId!)
          .or(conditions.join(","))
          .limit(1);

        return (potentialMatches?.length || 0) > 0;
      });

      if (needsLinking) {
        const launched = await step.run("launch-account-linking", async () => {
          const { data: linkJourney } = await admin.from("journey_definitions")
            .select("id, name")
            .eq("workspace_id", workspace_id)
            .eq("trigger_intent", "account_linking")
            .eq("enabled", true)
            .limit(1).single();

          if (!linkJourney) return false;

          await postInternalNote(admin, ticket_id,
            `[System] Potential unlinked accounts detected. Launching account linking journey before processing request.`);

          await buildCombinedEmailJourney({
            workspaceId: workspace_id, ticketId: ticket_id, customerId: state.customerId!,
            matchedJourneyIntent: "account_linking", matchedJourneyId: linkJourney.id,
          });
          await addTicketTag(ticket_id, "j:account_linking");
          await markFirstTouch(ticket_id, "journey");
          await admin.from("tickets").update({ handled_by: `Journey: ${linkJourney.name}` }).eq("id", ticket_id);

          const config = await getChannelConfig(admin, workspace_id, state.ch);
          await admin.from("tickets").update({ status: config.ticket_status_after_ai }).eq("id", ticket_id);
          return true;
        });

        if (launched) return { status: "account_linking_launched" };
      }
    }

    // ── Step 3: Clarification mode ──
    if (state.clarifyTurn > 0 && state.clarifyTurn < 3) {
      return await step.run("handle-clarification", async () => {
        const config = await getChannelConfig(admin, workspace_id, state.ch);
        const ctx = await assembleTicketContext(workspace_id, ticket_id);
        const customerCtx = ctx.systemPrompt.split("CUSTOMER CONTEXT:")[1]?.split("CHANNEL")[0]?.trim() || "";
        const history = ctx.conversationHistory.map(m => `${m.role}: ${m.content}`).join("\n");
        const handlers = await getHandlerNames(admin, workspace_id, state.hasCustomer, state.ch);
        const intent = await classifyIntent(message_body, customerCtx, history, handlers);

        await postInternalNote(admin, ticket_id,
          `[System] AI clarification turn ${state.clarifyTurn + 1}: "${intent.intent}" (${intent.confidence}%)`);
        await admin.from("tickets").update({ ai_detected_intent: intent.intent, ai_intent_confidence: intent.confidence }).eq("id", ticket_id);

        if (intent.confidence >= config.confidence_threshold) {
          await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", ticket_id);
          await routeAndExecute(admin, workspace_id, ticket_id, state.ch, intent, message_body, customerCtx, state.hasCustomer);
          return { status: "routed_after_clarification", handler: intent.handler_type };
        }

        const newTurn = state.clarifyTurn + 1;
        await admin.from("tickets").update({ ai_clarification_turn: newTurn }).eq("id", ticket_id);

        if (newTurn >= 3) {
          await postInternalNote(admin, ticket_id, `[System] AI clarification limit reached (3 turns). Escalating.`);
          await escalateToAgent(admin, workspace_id, ticket_id, state.ch, intent.intent, intent.confidence, message_body, customerCtx);
          return { status: "escalated", reason: "clarification_limit" };
        }

        const question = await generateClarification(message_body, intent.intent, intent.confidence, state.ch);
        await sendResponse(admin, workspace_id, ticket_id, state.ch, question);
        await admin.from("tickets").update({ status: config.ticket_status_after_ai }).eq("id", ticket_id);
        return { status: "clarification_sent", turn: newTurn };
      });
    }

    // ── Step 4: Full pipeline ──
    return await step.run("full-pipeline", async () => {
      const config = await getChannelConfig(admin, workspace_id, state.ch);
      if (!config.enabled) return { status: "skipped", reason: "ai_disabled" };

      const ctx = await assembleTicketContext(workspace_id, ticket_id);
      const customerCtx = ctx.systemPrompt.split("CUSTOMER CONTEXT:")[1]?.split("CHANNEL")[0]?.trim() || "";
      const history = ctx.conversationHistory.map(m => `${m.role}: ${m.content}`).join("\n");
      const handlers = await getHandlerNames(admin, workspace_id, state.hasCustomer, state.ch);
      const intent = await classifyIntent(message_body, customerCtx, history, handlers);

      await postInternalNote(admin, ticket_id,
        `[System] Intent: "${intent.intent}" (${intent.confidence}%). Threshold: ${config.confidence_threshold}%`);
      await admin.from("tickets").update({ ai_detected_intent: intent.intent, ai_intent_confidence: intent.confidence }).eq("id", ticket_id);

      // No customer + account-related intent → ask for identification
      if (!state.hasCustomer && isAccountRelatedIntent(intent.intent)) {
        await postInternalNote(admin, ticket_id, `[System] Account-related intent but no customer. Asking for email/order number.`);
        await admin.from("tickets").update({ ai_clarification_turn: 1 }).eq("id", ticket_id);
        await sendResponse(admin, workspace_id, ticket_id, state.ch,
          "I'd be happy to help! Could you share the email address or order number associated with your account so I can pull up your details?");
        await admin.from("tickets").update({ status: config.ticket_status_after_ai }).eq("id", ticket_id);
        return { status: "asking_for_customer" };
      }

      // Confidence gate
      if (intent.confidence < config.confidence_threshold) {
        await postInternalNote(admin, ticket_id,
          `[System] Confidence ${intent.confidence}% below ${config.confidence_threshold}%. Entering clarification.`);
        await admin.from("tickets").update({ ai_clarification_turn: 1 }).eq("id", ticket_id);
        const question = await generateClarification(message_body, intent.intent, intent.confidence, state.ch);
        await sendResponse(admin, workspace_id, ticket_id, state.ch, question);
        await admin.from("tickets").update({ status: config.ticket_status_after_ai }).eq("id", ticket_id);
        return { status: "clarification_started", confidence: intent.confidence };
      }

      // Route and execute
      await routeAndExecute(admin, workspace_id, ticket_id, state.ch, intent, message_body, customerCtx, state.hasCustomer);
      return { status: "routed", handler: intent.handler_type, name: intent.handler_name };
    });
  },
);

// ── Routing ──

async function getHandlerNames(admin: ReturnType<typeof createAdminClient>, workspaceId: string, hasCustomer: boolean, channel: string): Promise<string> {
  const isSocial = channel === "social_comments";
  const parts: string[] = [];

  if (hasCustomer && !isSocial) {
    const { data: journeys } = await admin.from("journey_definitions")
      .select("name, trigger_intent").eq("workspace_id", workspaceId).eq("enabled", true);
    for (const j of journeys || []) parts.push(`Journey: ${j.name} (intent: ${j.trigger_intent || "n/a"})`);

    const { data: workflows } = await admin.from("workflows")
      .select("name, trigger_type").eq("workspace_id", workspaceId).eq("enabled", true);
    for (const w of workflows || []) parts.push(`Workflow: ${w.name} (type: ${w.trigger_type || "n/a"})`);
  }

  const { data: macros } = await admin.from("macros")
    .select("name, category").eq("workspace_id", workspaceId).limit(50);
  for (const m of macros || []) parts.push(`Macro: ${m.name}${m.category ? ` [${m.category}]` : ""}`);

  return parts.join("\n");
}

async function routeAndExecute(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string, ticketId: string, channel: string,
  intent: { intent: string; confidence: number; handler_type: string; handler_name: string },
  messageBody: string, customerCtx: string, hasCustomer: boolean,
) {
  const isSocial = channel === "social_comments";

  // Reset clarification on successful route
  await admin.from("tickets").update({ ai_clarification_turn: 0 }).eq("id", ticketId);
  const config = await getChannelConfig(admin, workspaceId, channel);

  // Get customer_id for journey launches
  const { data: ticketData } = await admin.from("tickets").select("customer_id").eq("id", ticketId).single();
  const customerId = ticketData?.customer_id || null;

  // 1. Journey
  if (hasCustomer && !isSocial && intent.handler_type === "journey") {
    const { data: journey } = await admin.from("journey_definitions")
      .select("id, name, trigger_intent").eq("workspace_id", workspaceId).eq("enabled", true)
      .ilike("name", `%${intent.handler_name}%`).limit(1).single();

    if (journey) {
      await postInternalNote(admin, ticketId, `[System] Routed to journey: ${journey.name} (${intent.confidence}%)`);
      await buildCombinedEmailJourney({
        workspaceId, ticketId, customerId: customerId || undefined,
        matchedJourneyIntent: journey.trigger_intent || intent.intent,
        matchedJourneyId: journey.id,
      });
      await addTicketTag(ticketId, `j:${journey.name.toLowerCase().replace(/\s+/g, "_")}`);
      await markFirstTouch(ticketId, "journey");
      await admin.from("tickets").update({ handled_by: `Journey: ${journey.name}`, status: config.ticket_status_after_ai }).eq("id", ticketId);
      return;
    }
  }

  // 2. Workflow
  if (hasCustomer && !isSocial && intent.handler_type === "workflow") {
    const { data: workflow } = await admin.from("workflows")
      .select("id, name, trigger_type").eq("workspace_id", workspaceId).eq("enabled", true)
      .ilike("name", `%${intent.handler_name}%`).limit(1).single();

    if (workflow) {
      await postInternalNote(admin, ticketId, `[System] Routed to workflow: ${workflow.name} (${intent.confidence}%)`);
      const { executeWorkflow } = await import("@/lib/workflow-executor");
      await executeWorkflow(workspaceId, ticketId, workflow.trigger_type || workflow.name);
      await addTicketTag(ticketId, `w:${workflow.name.toLowerCase().replace(/\s+/g, "_")}`);
      await markFirstTouch(ticketId, "workflow");
      await admin.from("tickets").update({ handled_by: `Workflow: ${workflow.name}`, status: config.ticket_status_after_ai }).eq("id", ticketId);
      return;
    }
  }

  // 3. Macro
  if (intent.handler_type === "macro") {
    const { data: macro } = await admin.from("macros")
      .select("id, name, content").eq("workspace_id", workspaceId)
      .ilike("name", `%${intent.handler_name}%`).limit(1).single();

    if (macro) {
      await postInternalNote(admin, ticketId, `[System] Routed to macro: ${macro.name} (${intent.confidence}%)`);
      const personalized = await personalizeMacro(macro.content, customerCtx, messageBody, channel);
      await sendResponse(admin, workspaceId, ticketId, channel, personalized);
      await markFirstTouch(ticketId, "ai");
      await admin.from("tickets").update({ handled_by: "AI Agent", status: config.ticket_status_after_ai }).eq("id", ticketId);
      return;
    }
  }

  // 4. KB article fallback
  const ragResult = await retrieveContext(workspaceId, messageBody, 3);
  if (ragResult.chunks?.length && ragResult.chunks[0].similarity > 0.7) {
    const chunk = ragResult.chunks[0];
    await postInternalNote(admin, ticketId,
      `[System] KB fallback: "${chunk.kb_title}" (${intent.confidence}%). No macro found — notification created.`);
    await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId, type: "knowledge_gap",
      title: `Missing macro for intent: ${intent.intent}`,
      body: `KB article "${chunk.kb_title}" used. Consider creating a macro.`,
      metadata: { intent: intent.intent, ticket_id: ticketId },
    });
    const response = await craftKBResponse(chunk.chunk_text, chunk.kb_title || "", messageBody, channel);
    await sendResponse(admin, workspaceId, ticketId, channel, response);
    await markFirstTouch(ticketId, "ai");
    await admin.from("tickets").update({ handled_by: "AI Agent", status: config.ticket_status_after_ai }).eq("id", ticketId);
    return;
  }

  // 5. Escalate
  await escalateToAgent(admin, workspaceId, ticketId, channel, intent.intent, intent.confidence, messageBody, customerCtx);
}

async function escalateToAgent(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string, ticketId: string, channel: string,
  intent: string, confidence: number, messageBody: string, customerCtx: string,
) {
  await postInternalNote(admin, ticketId,
    `[System] No handler matched for "${intent}" (${confidence}%). Escalating. Gap logged.`);

  const { data: ticket } = await admin.from("tickets").select("customer_id").eq("id", ticketId).single();

  await admin.from("escalation_gaps").insert({
    workspace_id: workspaceId, ticket_id: ticketId, customer_id: ticket?.customer_id || null,
    channel, detected_intent: intent, confidence, original_message: messageBody.slice(0, 2000),
    customer_context_summary: customerCtx.slice(0, 1000),
  });

  await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId, type: "escalation_gap",
    title: `AI escalated: ${intent || "unknown"}`,
    body: `No handler matched. "${messageBody.slice(0, 100)}..."`,
    metadata: { ticket_id: ticketId, intent, confidence },
  });

  await admin.from("tickets").update({ status: "open", ai_clarification_turn: 0 }).eq("id", ticketId);
}
