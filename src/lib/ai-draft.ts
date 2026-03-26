// AI Draft Generator for Phase 4
// Recognition-first: identifies intent → finds macro/KB article → personalizes response

import { createAdminClient } from "@/lib/supabase/admin";
import { buildContext, type WorkflowContext } from "@/lib/workflow-executor";
import { retrieveContext, type RAGContext } from "@/lib/rag";

interface AIChannelConfig {
  channel: string;
  personality_id: string | null;
  enabled: boolean;
  sandbox: boolean;
  instructions: string;
  max_response_length: number | null;
  confidence_threshold: number;
  auto_resolve: boolean;
}

interface AIPersonality {
  name: string;
  tone: string;
  style_instructions: string;
  sign_off: string | null;
  greeting: string | null;
  emoji_usage: string;
}

interface AIWorkflowMatch {
  id: string;
  name: string;
  trigger_intent: string;
  response_source: string;
  preferred_macro_id: string | null;
  post_response_workflow_id: string | null;
  allowed_actions: unknown[];
  match_patterns: string[];
  match_categories: string[];
}

export interface AIDraftResult {
  draft: string;
  confidence: number;
  tier: "auto" | "review" | "human";
  source_type: "macro" | "kb" | null;
  source_id: string | null;
  ai_workflow_id: string | null;
  reasoning: string;
  sandbox: boolean;
}

export async function generateAIDraft(
  workspaceId: string,
  ticketId: string,
): Promise<AIDraftResult> {
  const admin = createAdminClient();

  // 1. Load ticket + messages + customer context
  const context = await buildContext(admin, workspaceId, ticketId);
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("direction, body, author_type, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  const channel = (context.ticket.channel as string) || "email";

  // 2. Get channel config + personality
  const { data: channelConfig } = await admin
    .from("ai_channel_config")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("channel", channel)
    .single();

  if (!channelConfig?.enabled) {
    return { draft: "", confidence: 0, tier: "human", source_type: null, source_id: null, ai_workflow_id: null, reasoning: "AI not enabled for this channel", sandbox: true };
  }

  let personality: AIPersonality | null = null;
  if (channelConfig.personality_id) {
    const { data: p } = await admin
      .from("ai_personalities")
      .select("*")
      .eq("id", channelConfig.personality_id)
      .single();
    personality = p;
  }

  // 3. Check for matching AI workflow
  const { data: aiWorkflows } = await admin
    .from("ai_workflows")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("priority", { ascending: false });

  // 4. Build query from latest customer message
  const customerMessages = (messages || []).filter((m) => m.direction === "inbound");
  const lastMessage = customerMessages[customerMessages.length - 1];
  const query = [context.ticket.subject, lastMessage?.body].filter(Boolean).join(" ");

  // 5. RAG retrieval — find matching macros and KB articles
  const ragContext = await retrieveContext(workspaceId, query);

  // 6. Match AI workflow by intent
  const workflowMatch = matchAIWorkflow(aiWorkflows || [], ragContext, query);

  // 7. Determine response source
  let sourceType: "macro" | "kb" | null = null;
  let sourceId: string | null = null;
  let sourceContent = "";

  if (workflowMatch?.preferred_macro_id) {
    // Workflow specifies a preferred macro
    const { data: macro } = await admin
      .from("macros")
      .select("id, name, body_text, body_html")
      .eq("id", workflowMatch.preferred_macro_id)
      .single();
    if (macro) {
      sourceType = "macro";
      sourceId = macro.id;
      sourceContent = macro.body_text;
    }
  }

  if (!sourceContent && ragContext.macros.length > 0) {
    // Best matching macro
    sourceType = "macro";
    sourceId = ragContext.macros[0].id;
    sourceContent = ragContext.macros[0].body_text;
  }

  if (!sourceContent && ragContext.chunks.length > 0) {
    // Use KB chunks
    sourceType = "kb";
    sourceId = ragContext.chunks[0].kb_id;
    sourceContent = ragContext.chunks.map((c) => c.chunk_text).join("\n\n");
  }

  // 8. Build prompt and call Claude
  const topSimilarity = Math.max(
    ...(ragContext.macros.map((m) => m.similarity) || [0]),
    ...(ragContext.chunks.map((c) => c.similarity) || [0]),
    0,
  );
  const systemPrompt = buildSystemPrompt(
    channelConfig as AIChannelConfig,
    personality,
    context,
    ragContext,
    sourceContent,
    messages || [],
    { topSimilarity, matchCount: ragContext.macros.length + ragContext.chunks.length, sourceType: sourceType },
  );

  const result = await callClaude(systemPrompt, query);

  // 9. Determine tier based on confidence and channel threshold
  const threshold = channelConfig.confidence_threshold || 0.90;
  let tier: "auto" | "review" | "human";
  if (result.confidence >= threshold && channelConfig.auto_resolve) {
    tier = "auto";
  } else if (result.confidence >= 0.60) {
    tier = "review";
  } else {
    tier = "human";
  }

  // 10. Always suggest a macro if one was found (even for human tier)
  let suggestedMacroId: string | null = null;
  let suggestedMacroName: string | null = null;
  if (sourceType === "macro" && sourceId) {
    suggestedMacroId = sourceId;
    const { data: macroInfo } = await admin.from("macros").select("name").eq("id", sourceId).single();
    suggestedMacroName = macroInfo?.name || null;
  } else if (ragContext.macros.length > 0) {
    // Even if we used KB for the draft, suggest the best matching macro
    suggestedMacroId = ragContext.macros[0].id;
    suggestedMacroName = ragContext.macros[0].name;
  }

  // 11. Store on ticket
  await admin
    .from("tickets")
    .update({
      ai_draft: result.draft,
      ai_confidence: result.confidence,
      ai_tier: tier,
      ai_source_type: sourceType,
      ai_source_id: sourceId,
      ai_workflow_id: workflowMatch?.id || null,
      ai_drafted_at: new Date().toISOString(),
      ai_suggested_macro_id: suggestedMacroId,
      ai_suggested_macro_name: suggestedMacroName,
    })
    .eq("id", ticketId);

  // Increment macro usage count (only when actually used for draft, not just suggested)
  if (sourceType === "macro" && sourceId && tier !== "human") {
    try { await admin.rpc("increment_macro_usage", { macro_id: sourceId }); } catch {}
  }

  return {
    draft: result.draft,
    confidence: result.confidence,
    tier,
    source_type: sourceType,
    source_id: sourceId,
    ai_workflow_id: workflowMatch?.id || null,
    reasoning: result.reasoning,
    sandbox: channelConfig.sandbox,
  };
}

function matchAIWorkflow(
  workflows: AIWorkflowMatch[],
  ragContext: RAGContext,
  query: string,
): AIWorkflowMatch | null {
  const queryLower = query.toLowerCase();

  for (const wf of workflows) {
    // Check pattern matches
    const patterns = (wf.match_patterns as string[]) || [];
    if (patterns.some((p) => queryLower.includes(p.toLowerCase()))) {
      return wf;
    }

    // Check category matches against RAG results
    const categories = (wf.match_categories as string[]) || [];
    if (categories.length > 0) {
      const matchedCategories = [
        ...ragContext.chunks.map((c) => c.kb_category),
        ...ragContext.macros.map((m) => m.category).filter(Boolean),
      ];
      if (categories.some((cat) => matchedCategories.includes(cat))) {
        return wf;
      }
    }
  }

  return null;
}

function buildSystemPrompt(
  channelConfig: AIChannelConfig,
  personality: AIPersonality | null,
  context: WorkflowContext,
  ragContext: RAGContext,
  sourceContent: string,
  messages: { direction: string; body: string; author_type: string; created_at: string }[],
  matchInfo?: { topSimilarity: number; matchCount: number; sourceType: string | null },
): string {
  const parts: string[] = [];

  // Role
  parts.push("You are a customer support agent.");

  // Personality
  if (personality) {
    parts.push(`\nPersonality: ${personality.name}`);
    parts.push(`Tone: ${personality.tone}`);
    if (personality.style_instructions) parts.push(`Style: ${personality.style_instructions}`);
    if (personality.emoji_usage !== "none") parts.push(`Emoji usage: ${personality.emoji_usage}`);
  }

  // Channel instructions
  if (channelConfig.instructions) {
    parts.push(`\nChannel instructions (${channelConfig.channel}):\n${channelConfig.instructions}`);
  }
  if (channelConfig.max_response_length) {
    parts.push(`Maximum response length: ~${channelConfig.max_response_length} characters.`);
  }

  // Customer context
  if (context.customer) {
    const c = context.customer;
    parts.push(`\nCustomer: ${c.first_name || ""} ${c.last_name || ""} (${c.email})`);
    if (c.total_orders) parts.push(`Orders: ${c.total_orders}, LTV: $${((c.ltv_cents as number) / 100).toFixed(0)}`);
    if (c.subscription_status && c.subscription_status !== "none") parts.push(`Subscription: ${c.subscription_status}`);
  }

  // Order context
  if (context.order) {
    parts.push(`\nMost recent order: #${context.order.order_number} — ${context.order.financial_status}, ${context.order.fulfillment_status || "unfulfilled"}`);
  }

  // Fulfillment context
  if (context.fulfillment) {
    const f = context.fulfillment;
    parts.push(`Fulfillment: ${f.shopify_status || f.status || "unknown"}, shipped ${f.days_since} days ago`);
    if (f.carrier && f.tracking_number) parts.push(`Tracking: ${f.carrier} ${f.tracking_number}`);
    if (f.latest_location) parts.push(`Last location: ${f.latest_location}`);
  }

  // Source content (macro or KB)
  if (sourceContent) {
    parts.push("\n--- RESPONSE SOURCE (base your response on this) ---");
    parts.push(sourceContent);
    parts.push("--- END SOURCE ---");
    parts.push("\nIMPORTANT: Your response MUST be based on the source content above. Do not make up information. Personalize it for the customer using the context provided.");
  }

  // KB context (additional relevant chunks)
  if (ragContext.chunks.length > 0) {
    parts.push("\n--- KNOWLEDGE BASE CONTEXT ---");
    for (const chunk of ragContext.chunks.slice(0, 5)) {
      parts.push(`[${chunk.kb_title} — ${chunk.kb_category}]\n${chunk.chunk_text}\n`);
    }
    parts.push("--- END KB CONTEXT ---");
  }

  // Conversation history
  if (messages.length > 0) {
    parts.push("\n--- CONVERSATION ---");
    for (const m of messages.slice(-10)) {
      const role = m.direction === "inbound" ? "Customer" : "Agent";
      const body = (m.body || "").slice(0, 500);
      parts.push(`${role}: ${body}`);
    }
    parts.push("--- END CONVERSATION ---");
  }

  // Personality sign-off/greeting
  if (personality?.greeting) parts.push(`\nStart messages with a greeting like: ${personality.greeting}`);
  if (personality?.sign_off) parts.push(`End messages with: ${personality.sign_off}`);

  // Match quality info
  if (matchInfo) {
    parts.push(`\n--- MATCH QUALITY ---`);
    parts.push(`Best match similarity: ${(matchInfo.topSimilarity * 100).toFixed(0)}%`);
    parts.push(`Number of matching sources: ${matchInfo.matchCount}`);
    if (matchInfo.sourceType) parts.push(`Primary source type: ${matchInfo.sourceType}`);
    parts.push("--- END MATCH QUALITY ---");
  }

  // Output format
  parts.push('\nRespond with JSON: { "draft": "your response to the customer", "confidence": 0.XX, "reasoning": "brief explanation of what you matched and why" }');
  parts.push("\nConfidence guidelines — be GENEROUS with confidence when you have good source material:");
  parts.push("- 0.92-0.98 : A macro or KB article clearly addresses the customer's question. You have the source content and customer context. This is the EXPECTED score for most tickets with a matching macro.");
  parts.push("- 0.80-0.91 : The source is relevant but you needed to adapt it significantly, OR the customer's request is ambiguous.");
  parts.push("- 0.60-0.79 : Weak match — the source only partially addresses the request.");
  parts.push("- Below 0.50 : No relevant source found — set draft to empty string.");
  parts.push("\nIMPORTANT: If you have a matching macro AND you can see the customer's account details (name, orders, subscription), your confidence should be 0.90+. Having the right macro + customer context = high confidence.");

  return parts.join("\n");
}

async function callClaude(
  systemPrompt: string,
  userMessage: string,
): Promise<{ draft: string; confidence: number; reasoning: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { draft: "", confidence: 0, reasoning: "No Anthropic API key configured" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Claude API error:", text);
      return { draft: "", confidence: 0, reasoning: `API error: ${res.status}` };
    }

    const data = await res.json();
    const content = data.content?.[0]?.text || "";

    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        draft: parsed.draft || "",
        confidence: Math.min(1, Math.max(0, parsed.confidence || 0)),
        reasoning: parsed.reasoning || "",
      };
    }

    return { draft: content, confidence: 0.3, reasoning: "Could not parse structured response" };
  } catch (err) {
    console.error("Claude call failed:", err);
    return { draft: "", confidence: 0, reasoning: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
