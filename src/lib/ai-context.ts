// Multi-turn AI context assembler
// Builds full conversation context with customer history for Claude

import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveContext, type RAGContext } from "@/lib/rag";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssembledContext {
  systemPrompt: string;
  conversationHistory: ConversationMessage[];
  ragContext: RAGContext;
  turnCount: number;
  turnLimit: number;
  channel: string;
  sandbox: boolean;
  confidenceThreshold: number;
  autoResolve: boolean;
}

export async function assembleTicketContext(
  workspaceId: string,
  ticketId: string,
): Promise<AssembledContext> {
  const admin = createAdminClient();

  // 1. Fetch ticket
  const { data: ticket } = await admin
    .from("tickets")
    .select("*, customers(id, email, first_name, last_name, phone, retention_score, subscription_status, total_orders, ltv_cents, shopify_customer_id, email_marketing_status, sms_marketing_status)")
    .eq("id", ticketId)
    .single();

  if (!ticket) throw new Error("Ticket not found");

  const customer = ticket.customers as {
    id: string; email: string; first_name: string | null; last_name: string | null;
    phone: string | null; retention_score: number; subscription_status: string;
    total_orders: number; ltv_cents: number; shopify_customer_id: string | null;
    email_marketing_status: string | null; sms_marketing_status: string | null;
  } | null;

  const channel = ticket.channel || "email";

  // 2. Fetch channel config + personality
  const { data: channelConfig } = await admin
    .from("ai_channel_config")
    .select("personality_id, enabled, sandbox, instructions, max_response_length, confidence_threshold, auto_resolve, ai_turn_limit")
    .eq("workspace_id", workspaceId)
    .eq("channel", channel)
    .single();

  let personality: { name: string; tone: string; style_instructions: string; sign_off: string | null; greeting: string | null; emoji_usage: string } | null = null;
  if (channelConfig?.personality_id) {
    const { data: p } = await admin.from("ai_personalities").select("name, tone, style_instructions, sign_off, greeting, emoji_usage").eq("id", channelConfig.personality_id).single();
    personality = p;
  }

  const turnLimit = channel === "social_comments" ? 1 : (channelConfig?.ai_turn_limit || ticket.ai_turn_limit || 4);

  // 3. Fetch all messages — include external + AI sandbox drafts (so AI knows what it already said)
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("direction, body, author_type, visibility, created_at")
    .eq("ticket_id", ticketId)
    .or("visibility.eq.external,author_type.eq.ai")
    .order("created_at", { ascending: true });

  // Build conversation history — strip sandbox prefixes from AI messages
  const conversationHistory: ConversationMessage[] = [];
  const allMessages = (messages || []).map(m => {
    if (m.author_type === "ai" && m.visibility === "internal") {
      // Strip sandbox prefix so AI sees its own clean responses
      const cleaned = (m.body || "")
        .replace(/\[AI Draft.*?(?:Turn \d+|Close)\]\s*/i, "")
        .replace(/\s*Confidence:.*?Source:.*$/i, "")
        .trim();
      return { ...m, body: cleaned, direction: "outbound" as const };
    }
    return m;
  }).filter(m => {
    // Exclude system notes and non-AI internal notes
    if (m.visibility === "internal" && m.author_type !== "ai") return false;
    return true;
  });

  // For multi-turn (turn 2+), prepend context summary and only include recent messages
  if (ticket.ai_turn_count > 0 && allMessages.length > 2) {
    // Summarize all but the last customer message as context
    const olderMsgs = allMessages.slice(0, -1);
    const summary = olderMsgs.map((m, i) => {
      const who = m.direction === "inbound" ? "Customer" : "Agent";
      const text = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
      return `${who} (msg ${i + 1}): ${text}`;
    }).join("\n");

    conversationHistory.push({
      role: "user",
      content: `[Conversation history for context — do NOT re-address these topics:\n${summary}]\n\n---\nMy new question (RESPOND ONLY TO THIS):\n${(allMessages[allMessages.length - 1].body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}`,
    });
  } else {
    // First turn: include all messages normally
    for (const m of allMessages) {
      const role = m.direction === "inbound" ? "user" : "assistant";
      const content = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (content) conversationHistory.push({ role, content });
    }
  }

  // 4. Build customer profile
  const customerParts: string[] = [];
  if (customer) {
    const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ");
    if (name) customerParts.push(`Name: ${name}`);
    customerParts.push(`Email: ${customer.email}`);
    if (customer.phone) customerParts.push(`Phone: ${customer.phone}`);
    customerParts.push(`Retention Score: ${customer.retention_score}/100`);
    customerParts.push(`Total Orders: ${customer.total_orders}`);
    customerParts.push(`Lifetime Value: $${(customer.ltv_cents / 100).toFixed(2)}`);
    if (customer.subscription_status !== "none") {
      customerParts.push(`Subscription: ${customer.subscription_status}`);
    }
    const emailMktg = customer.email_marketing_status === "subscribed";
    const smsMktg = customer.sms_marketing_status === "subscribed";
    customerParts.push(`Email Marketing: ${emailMktg ? "subscribed" : "not subscribed"}`);
    customerParts.push(`SMS Marketing: ${smsMktg ? "subscribed" : "not subscribed"}`);

    // Fetch recent orders
    const { data: orders } = await admin
      .from("orders")
      .select("order_number, financial_status, fulfillment_status, total_cents, currency, created_at, fulfillments")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false })
      .limit(3);

    if (orders?.length) {
      customerParts.push("\nRecent Orders:");
      for (const o of orders) {
        const total = `$${(o.total_cents / 100).toFixed(2)} ${o.currency}`;
        const date = new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        customerParts.push(`  #${o.order_number} — ${total} — ${o.financial_status || "unknown"} / ${o.fulfillment_status || "unfulfilled"} — ${date}`);
        // Include fulfillment tracking if available
        const fulfillments = o.fulfillments as { trackingInfo?: { number: string; url: string | null; company: string | null }[]; status?: string }[] | null;
        if (fulfillments?.length) {
          for (const f of fulfillments) {
            if (f.trackingInfo?.length) {
              for (const t of f.trackingInfo) {
                customerParts.push(`    Tracking: ${t.company || "carrier"} ${t.number}${t.url ? ` — ${t.url}` : ""}`);
              }
            }
            if (f.status) customerParts.push(`    Fulfillment status: ${f.status}`);
          }
        }
      }
    }

    // Fetch active subscriptions
    const { data: subs } = await admin
      .from("subscriptions")
      .select("status, billing_interval, billing_interval_count, next_billing_date, items")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customer.id)
      .in("status", ["active", "paused"])
      .limit(3);

    if (subs?.length) {
      customerParts.push("\nSubscriptions:");
      for (const s of subs) {
        const items = (s.items as { title: string | null }[] | null)?.map(i => i.title).filter(Boolean).join(", ") || "unknown items";
        const freq = s.billing_interval_count && s.billing_interval ? `every ${s.billing_interval_count} ${s.billing_interval}` : "";
        customerParts.push(`  ${s.status} — ${items} ${freq}`);
        if (s.next_billing_date) customerParts.push(`    Next billing: ${new Date(s.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`);
      }
    }

    // Count open tickets for this customer
    const { count: openTickets } = await admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customer.id)
      .eq("status", "open");
    if (openTickets && openTickets > 1) customerParts.push(`\nNote: Customer has ${openTickets} open tickets`);
  }

  // 5. RAG retrieval — embed latest customer message only
  const latestCustomerMsg = [...(messages || [])].reverse().find(m => m.direction === "inbound");
  const ragQuery = latestCustomerMsg ? (latestCustomerMsg.body || "").replace(/<[^>]+>/g, " ").trim().slice(0, 500) : (ticket.subject || "");
  const ragContext = await retrieveContext(workspaceId, ragQuery, 5);

  // 6. Build system prompt
  const promptParts: string[] = [];

  // Personality
  if (personality) {
    promptParts.push(`You are a customer support agent. Your name is ${personality.name}.`);
    promptParts.push(`Tone: ${personality.tone}`);
    if (personality.style_instructions) promptParts.push(personality.style_instructions);
    if (personality.greeting) promptParts.push(`Start messages with a greeting like: ${personality.greeting}`);
    if (personality.sign_off) promptParts.push(`End messages with: ${personality.sign_off}`);
    if (personality.emoji_usage === "none") promptParts.push("Do not use emojis.");
    else if (personality.emoji_usage === "minimal") promptParts.push("Use emojis sparingly.");
  } else {
    promptParts.push("You are a friendly, professional customer support agent.");
  }

  // Customer context
  if (customerParts.length > 0) {
    promptParts.push("\nCUSTOMER CONTEXT:");
    promptParts.push(customerParts.join("\n"));
  }

  // Channel instructions
  if (channelConfig?.instructions) {
    promptParts.push("\nCHANNEL INSTRUCTIONS:");
    promptParts.push(channelConfig.instructions);
  }

  // Conversation rules
  promptParts.push("\nCONVERSATION RULES:");
  promptParts.push(`- This is turn ${ticket.ai_turn_count + 1} of a maximum ${turnLimit} AI-handled turns.`);
  if (ticket.agent_intervened) {
    promptParts.push("- A human agent intervened earlier in this conversation. Be aware of any commitments they made.");
  }
  promptParts.push("- If you cannot answer with confidence, respond with exactly: ESCALATE: [reason]");
  promptParts.push("- If the customer wants to cancel, respond with exactly: ESCALATE: cancellation_intent");
  promptParts.push("- If the customer expresses frustration or anger, respond with exactly: ESCALATE: negative_sentiment");
  promptParts.push("- If the customer asks for a human, respond with exactly: ESCALATE: human_requested");
  promptParts.push("- Never mention that you are an AI unless directly asked.");
  promptParts.push("- Never fabricate order details, tracking numbers, or product claims.");
  promptParts.push("- FORMATTING: Keep responses SHORT. Maximum 2 sentences per paragraph. Put a blank line between every paragraph. The response should have 2-4 short paragraphs, never one big block.");
  promptParts.push("- FORMATTING: Do not use markdown formatting like **, __, or bullet points. Write plain text only. No headers, no bold, no lists.");
  promptParts.push("- FOCUS: Only answer the customer's LATEST message. The conversation history is for context only — do NOT repeat or re-address anything from previous turns.");
  promptParts.push("- Do NOT reference or acknowledge topics from earlier in the conversation unless the customer explicitly brings them up again.");
  promptParts.push("- VOICE: Mirror the customer's own words and phrasing. If they say 'stock up', you say 'stock up', not 'place a large order'. Match their energy and vocabulary.");
  promptParts.push("- ACTIONS: When the system has performed an action (like signing someone up), lead with a direct confirmation: 'Done!', 'You're all set!', 'Got it, I've signed you up!'. Then briefly explain what happened. Do not re-explain what the action is — they already know.");
  if (ticket.ai_turn_count > 0) {
    promptParts.push("- This is a follow-up message. Keep it brief and conversational. Just answer the question directly.");
    promptParts.push("- Do NOT start with flattery, compliments about their loyalty, or 'pat on the back' openers like 'I'm so glad' or 'It's wonderful'. Just get to the point.");
    promptParts.push("- Do NOT include a sign-off or team signature. Just end naturally.");
  } else {
    promptParts.push("- Sign-off should be on its own line, separated by a blank line from the rest of the message.");
  }

  // AI Workflows — tell the AI what actions it can offer
  const { data: aiWorkflows } = await admin
    .from("ai_workflows")
    .select("name, description, trigger_intent, match_patterns, config")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true);

  if (aiWorkflows?.length) {
    promptParts.push("\nAVAILABLE ACTIONS:");
    for (const wf of aiWorkflows) {
      const config = wf.config as Record<string, unknown>;
      promptParts.push(`- ${wf.name}: ${wf.description || ""}`);
      if (config.offer_message) promptParts.push(`  When relevant, offer: "${config.offer_message}"`);
      promptParts.push(`  Trigger keywords: ${(wf.match_patterns || []).join(", ")}`);
    }
    promptParts.push("- When a customer confirms they want an action, acknowledge it and let them know it's being processed.");
    promptParts.push("- DISCOUNT FLOW: If a customer asks about discounts, check their marketing status in the customer context above. If they are ALREADY subscribed to both email AND SMS, give them the code SHOPCX and tell them to use it at checkout. If they have an active subscription, offer to apply SHOPCX to their next subscription order too. If they are NOT subscribed, offer to sign them up for email and SMS to get exclusive promotions.");
    promptParts.push("- NEVER ask the customer to verify information you already have. Check the customer context first.");
    promptParts.push("- NEVER claim you performed an action (like applying a coupon or signing someone up) unless a [System] note in the conversation confirms it was done. If the customer asks you to do something, say you are processing it — the system will handle the action.");
  }

  // KB context
  if (ragContext.chunks.length > 0) {
    promptParts.push("\nKNOWLEDGE BASE CONTEXT:");
    for (const chunk of ragContext.chunks.slice(0, 5)) {
      promptParts.push(`[${chunk.kb_title}]: ${chunk.chunk_text.slice(0, 500)}`);
    }
  }

  return {
    systemPrompt: promptParts.join("\n"),
    conversationHistory,
    ragContext,
    turnCount: ticket.ai_turn_count,
    turnLimit,
    channel,
    sandbox: channelConfig?.sandbox ?? true,
    confidenceThreshold: channelConfig?.confidence_threshold || 0.90,
    autoResolve: channelConfig?.auto_resolve ?? false,
  };
}
