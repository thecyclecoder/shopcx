// Multi-turn AI context assembler
// Builds full conversation context with customer history for Claude

import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveContext, type RAGContext } from "@/lib/rag";
import { getStoreCreditBalance } from "@/lib/store-credit";

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

  // 4. Build customer profile — include linked profiles
  const customerParts: string[] = [];
  let linkedCustomerIds: string[] = [];
  if (customer) {
    // Check for linked profiles
    const { data: links } = await admin
      .from("customer_links")
      .select("group_id")
      .eq("customer_id", customer.id);

    if (links?.length && links[0].group_id) {
      const { data: linkedProfiles } = await admin
        .from("customer_links")
        .select("customer_id, customers(email, first_name, last_name)")
        .eq("group_id", links[0].group_id);

      linkedCustomerIds = (linkedProfiles || [])
        .map(lp => lp.customer_id)
        .filter((id: string) => id !== customer.id);

      if (linkedCustomerIds.length > 0) {
        const linkedEmails = (linkedProfiles || [])
          .filter(lp => lp.customer_id !== customer.id)
          .map(lp => (lp.customers as unknown as { email: string })?.email)
          .filter(Boolean);
        customerParts.push(`Linked Profiles: ${linkedEmails.join(", ")} (combined data shown below)`);
      }
    }

    // All customer IDs to query across (current + linked)
    const allCustomerIds = [customer.id, ...linkedCustomerIds];

    const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ");
    if (name) customerParts.push(`Name: ${name}`);
    customerParts.push(`Email: ${customer.email}`);
    if (customer.phone) customerParts.push(`Phone: ${customer.phone}`);

    // Compute combined stats across linked profiles
    if (linkedCustomerIds.length > 0) {
      const { data: allCusts } = await admin
        .from("customers")
        .select("retention_score, total_orders, ltv_cents, subscription_status")
        .in("id", allCustomerIds);

      const combinedOrders = (allCusts || []).reduce((sum, c) => sum + (c.total_orders || 0), 0);
      const combinedLtv = (allCusts || []).reduce((sum, c) => sum + (c.ltv_cents || 0), 0);
      const maxRetention = Math.max(...(allCusts || []).map(c => c.retention_score || 0));
      const hasActiveSub = (allCusts || []).some(c => c.subscription_status === "active");

      customerParts.push(`Retention Score: ${maxRetention}/100`);
      customerParts.push(`Total Orders (combined): ${combinedOrders}`);
      customerParts.push(`Lifetime Value (combined): $${(combinedLtv / 100).toFixed(2)}`);
      if (hasActiveSub) customerParts.push(`Subscription: active`);
    } else {
      customerParts.push(`Retention Score: ${customer.retention_score}/100`);
      customerParts.push(`Total Orders: ${customer.total_orders}`);
      customerParts.push(`Lifetime Value: $${(customer.ltv_cents / 100).toFixed(2)}`);
      if (customer.subscription_status !== "none") {
        customerParts.push(`Subscription: ${customer.subscription_status}`);
      }
    }

    const emailMktg = customer.email_marketing_status === "subscribed";
    const smsMktg = customer.sms_marketing_status === "subscribed";
    customerParts.push(`Email Marketing: ${emailMktg ? "subscribed" : "not subscribed"}`);
    customerParts.push(`SMS Marketing: ${smsMktg ? "subscribed" : "not subscribed"}`);

    // Fetch store credit balance
    if (customer.shopify_customer_id) {
      try {
        const credit = await getStoreCreditBalance(workspaceId, customer.shopify_customer_id);
        if (credit.balance > 0) {
          customerParts.push(`Store Credit: $${credit.balance.toFixed(2)} ${credit.currency}`);
        } else {
          customerParts.push(`Store Credit: None`);
        }
      } catch {
        // Skip if store credit query fails
      }
    }

    // Fetch recent orders (across linked profiles)
    // allCustomerIds already defined above
    let ordersQuery = admin
      .from("orders")
      .select("order_number, financial_status, fulfillment_status, total_cents, currency, created_at, fulfillments")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(3);
    if (allCustomerIds.length === 1) {
      ordersQuery = ordersQuery.eq("customer_id", customer.id);
    } else {
      ordersQuery = ordersQuery.in("customer_id", allCustomerIds);
    }
    const { data: orders } = await ordersQuery;

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

    // Fetch active subscriptions (across linked profiles)
    let subsQuery = admin
      .from("subscriptions")
      .select("status, billing_interval, billing_interval_count, next_billing_date, items")
      .eq("workspace_id", workspaceId)
      .in("status", ["active", "paused"])
      .limit(3);
    if (allCustomerIds.length === 1) {
      subsQuery = subsQuery.eq("customer_id", customer.id);
    } else {
      subsQuery = subsQuery.in("customer_id", allCustomerIds);
    }
    const { data: subs } = await subsQuery;

    if (subs?.length) {
      customerParts.push("\nSubscriptions:");
      for (const s of subs) {
        const items = (s.items as { title: string | null }[] | null)?.map(i => i.title).filter(Boolean).join(", ") || "unknown items";
        const freq = s.billing_interval_count && s.billing_interval ? `every ${s.billing_interval_count} ${s.billing_interval}` : "";
        customerParts.push(`  ${s.status} — ${items} ${freq}`);
        if (s.next_billing_date) customerParts.push(`    Next billing: ${new Date(s.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`);
      }
    }

    // Count open tickets for this customer (across linked profiles)
    let openQuery = admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "open");
    if (allCustomerIds.length === 1) {
      openQuery = openQuery.eq("customer_id", customer.id);
    } else {
      openQuery = openQuery.in("customer_id", allCustomerIds);
    }
    const { count: openTickets } = await openQuery;
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

  // Playbook summary (from a previously completed playbook on this ticket)
  const playbookCtx = ticket.playbook_context as Record<string, unknown> | null;
  if (playbookCtx?.summary && !ticket.active_playbook_id) {
    promptParts.push("\nPREVIOUS PLAYBOOK RESOLUTION:");
    promptParts.push(String(playbookCtx.summary));
    promptParts.push("Use this context to understand what was already resolved. Do not re-negotiate or re-offer. If the customer references this issue, acknowledge what was decided and restate next steps if applicable.");
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
  promptParts.push("- FORMATTING: Keep responses SHORT. Maximum 2-3 sentences per paragraph. Each new point or shift in direction gets its own paragraph. Put a blank line between every paragraph. Never write one big block of text.");
  promptParts.push("- FORMATTING: Do not use markdown formatting like **, __, or bullet points. Write plain text only. No headers, no bold, no lists.");
  promptParts.push("- LENGTH: Your response should NEVER be longer than the source macro or KB article you're drawing from. If the macro is 2 sentences, your response should be about 2 sentences. Match the source length, don't expand it.");
  if (ticket.channel === "chat" || ticket.channel === "sms" || ticket.channel === "meta_dm") {
    promptParts.push("- CHANNEL LENGTH: This is a " + ticket.channel + " conversation. Keep responses extra short — 1-2 sentences max. Be conversational and direct, not formal.");
  }
  promptParts.push("- ENDING: If your message ends with a question, STOP there. Do not add filler like 'Let me know if you need anything else' or 'Don't hesitate to reach out' after a question. The question IS the ending.");
  promptParts.push("- FOCUS: Only answer the customer's LATEST message. The conversation history is for context only — do NOT repeat or re-address anything from previous turns.");
  promptParts.push("- Do NOT reference or acknowledge topics from earlier in the conversation unless the customer explicitly brings them up again.");
  promptParts.push("- VOICE: Mirror the customer's own words and phrasing. If they say 'stock up', you say 'stock up', not 'place a large order'. Match their energy and vocabulary.");
  promptParts.push("- ACTIONS: When the system has performed an action (like signing someone up), lead with a direct confirmation: 'Done!', 'You're all set!', 'Got it, I've signed you up!'. Then briefly explain what happened. Do not re-explain what the action is — they already know.");
  // Check if there are already outbound messages (workflow or AI already greeted)
  const hasExistingReplies = allMessages.some(m => m.direction === "outbound");
  if (ticket.ai_turn_count > 0 || hasExistingReplies) {
    promptParts.push("- This is a follow-up in an ongoing conversation. Keep it brief and conversational. Just answer the question directly.");
    promptParts.push("- Do NOT greet the customer again (no 'Hi [name]'). They've already been greeted earlier in this thread.");
    promptParts.push("- Do NOT start with flattery, compliments about their loyalty, or 'pat on the back' openers. Just get to the point.");
    promptParts.push("- Do NOT include a sign-off or team signature. Just end naturally.");
  } else {
    promptParts.push("- Sign-off should be on its own line, separated by a blank line from the rest of the message.");
    if (customer && customer.retention_score >= ((await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single()).data?.vip_retention_threshold || 85)) {
      promptParts.push("- This customer is a VIP! Start with a warm acknowledgment like 'Thanks for being such a valued member of our family!' or similar. Make them feel special.");
    }
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

    // Workflow-specific instructions
    promptParts.push("\nWORKFLOW INSTRUCTIONS:");
    promptParts.push("- RETURN FLOW: If customer wants to return or exchange, ask what's wrong (wrong item, damaged, don't like it). Then escalate to an agent for return processing. Do NOT promise refunds or return labels — say the team will follow up with return instructions.");
    promptParts.push("- ADDRESS FLOW: If customer wants to change their shipping address, ask for the new full address. If their most recent order is unfulfilled, confirm and say you're updating it. If it's already fulfilled/shipped, explain it's already on its way and provide tracking info.");
    promptParts.push("- SUBSCRIPTION FLOW: If customer wants to skip their next subscription order, confirm the change and say you're processing it. If they want to swap a product, ask which product they'd like instead. If they want to change frequency, ask what frequency they prefer.");
    promptParts.push("- ORDER STATUS FLOW: If customer asks where their order is, check the order info in the customer context. If unfulfilled, say it's being prepared. If fulfilled, provide the tracking info. If delivered, confirm the delivery.");
    // Load mapped coupons for AI
    const { data: coupons } = await admin
      .from("coupon_mappings")
      .select("code, summary, use_cases, customer_tier, value_type, value, notes")
      .eq("workspace_id", workspaceId)
      .eq("ai_enabled", true);

    const isVip = customer && customer.retention_score >= ((await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single()).data?.vip_retention_threshold || 85);

    if (coupons?.length) {
      // Filter by customer tier
      const available = coupons.filter(c =>
        c.customer_tier === "all" ||
        (c.customer_tier === "vip" && isVip) ||
        (c.customer_tier === "non_vip" && !isVip)
      );
      if (available.length > 0) {
        promptParts.push(`\nAVAILABLE COUPONS (customer is ${isVip ? "VIP" : "non-VIP"}):`);
        for (const c of available) {
          promptParts.push(`- Code: ${c.code} — ${c.summary || `${c.value}${c.value_type === "percentage" ? "%" : "$"} off`}`);
          promptParts.push(`  Use cases: ${c.use_cases.join(", ")}`);
          if (c.notes) promptParts.push(`  Note: ${c.notes}`);
        }
        promptParts.push("- DISCOUNT FLOW: When a customer asks about discounts, offer the appropriate coupon based on the use case. If they are NOT subscribed to email+SMS marketing, offer signup first. If they have an active subscription, offer to apply the coupon to their next order too.");
      }
    }

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
