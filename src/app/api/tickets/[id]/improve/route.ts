import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { runImproveActions, type ImproveAction } from "@/lib/improve-actions";
import { OPUS_MODEL } from "@/lib/ai-models";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Fast-path: admin already approved a set of proposed actions in the
 * frontend. Skip Opus entirely and dispatch deterministically. Avoids
 * the "Opus forgot the JSON it emitted last turn" failure mode where
 * the model returns conversational text instead of action_execute JSON.
 */
async function executeActionsDirect(
  workspaceId: string,
  ticketId: string,
  actions: ImproveAction[],
): Promise<NextResponse> {
  const { results } = await runImproveActions(workspaceId, ticketId, actions);
  return NextResponse.json({
    type: "action_execute",
    message: "Done.\n\nResults:\n" + results.map(r => `• ${r}`).join("\n"),
    proposed_actions: actions,
    action_results: results,
  });
}

const SYSTEM_PROMPT = `You are a support AI assistant for admins (Customer Experience managers). Your job is to help them:
  1. UNDERSTAND why a ticket was handled poorly (use get_ticket_analysis + get_customer_account)
  2. FIX the ticket NOW (execute remediation actions)
  3. PROPOSE prompt rules so the AI doesn't make the same mistake again

You can chain multiple actions in a single approval cycle. Example admin request:
  "Create a return for her latest order. Add prompts so this doesn't happen again. Then send her the label."
You should propose: [create_return, propose_sonnet_prompt, send_message] in one batch.

## Workflow:
1. ALWAYS verify before executing — propose the actions, wait for admin's "yes" / "do it" / approve.
2. After approval, return the SAME proposed_actions as type:"action_execute".
3. Action results flow into chained actions automatically — e.g. {{label_url}} in a send_message body becomes the actual label URL after create_return runs.

## Available action types:

REMEDIATION (fix the ticket):
  • create_return(shopify_order_id, reason?, free_label?)
       — Creates EasyPost return label. Result includes label_url + tracking_number.
  • partial_refund(shopify_order_id, amount_cents, reason?)
  • update_line_item_price(contract_id, variant_id, base_price_cents)
  • swap_variant(contract_id, old_variant_id, new_variant_id, quantity?)
  • change_next_date(contract_id, date)        — date format: 2026-05-15
  • change_frequency(contract_id, interval, interval_count)
  • update_shipping_address(contract_id, address: {address1, city, province, zip, country, first_name, last_name})
  • apply_coupon(contract_id, code)
  • reactivate(contract_id)
  • crisis_pause(contract_id, crisis_action_id)
  • skip_next_order(contract_id)
  • close_ticket
  • reopen_ticket

CUSTOMER COMMUNICATION:
  • send_message(body)
       — HTML body. For return labels, use the placeholder {{label_url}} on its own line — it renders as a clickable CTA button after create_return runs.

CALIBRATION (so this doesn't happen again):
  • propose_sonnet_prompt(title, content, category?)
       — Drafts a NEW conversation-AI rule for admin review. category: rule | approach | knowledge | tool_hint.
       — Status defaults to 'proposed' — admin must approve in Settings → AI → Prompts before it takes effect.
  • propose_grader_rule(title, content)
       — Drafts a calibration rule for the AI quality grader (rare; usually surfaced via score override flow).

## Tools (read-only, call freely):
  • get_customer_account, get_product_knowledge, get_returns, get_chargebacks
  • get_email_history, get_crisis_status, get_dunning_status
  • get_ticket_analysis — pulls the latest ticket_analyses row + score + issues + analyst's reasoning so you can answer "why was this graded N/10?"

## Response format:
Return JSON. Only include fields relevant to the type:
{
  "type": "prompt" | "architecture" | "question" | "action_proposal" | "action_execute",
  "message": "conversational response to the admin",
  "proposed_rule": { "title": "...", "content": "...", "category": "rule" },
  "architecture_description": "...",
  "proposed_actions": [{ "type": "create_return", "shopify_order_id": "..." }, { "type": "send_message", "body": "Here's your label: {{label_url}}" }]
}`;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured" }, { status: 503 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Verify admin/owner role
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Admin or owner role required" }, { status: 403 });
  }

  const body = await request.json();

  // Fast-path: admin already approved a set of proposed actions —
  // dispatch them deterministically without re-running Opus. Avoids the
  // "Opus forgets the JSON it emitted last turn" failure mode.
  if (Array.isArray(body?.execute_actions) && body.execute_actions.length > 0) {
    return executeActionsDirect(workspaceId, ticketId, body.execute_actions);
  }

  const { message, conversationHistory } = body as {
    message: string;
    conversationHistory: { role: "user" | "assistant"; content: string }[];
  };

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  // Get ticket details
  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, tags, status, channel, customer_id, ai_turn_count, escalation_reason")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }

  // Get ticket messages
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("direction, visibility, author_type, body, created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .limit(50);

  // Get customer info if available
  let customerInfo = "";
  if (ticket.customer_id) {
    const { data: cust } = await admin
      .from("customers")
      .select("first_name, last_name, email, subscription_status, retention_score")
      .eq("id", ticket.customer_id)
      .single();
    if (cust) {
      const { getCustomerStats } = await import("@/lib/customer-stats");
      const stats = await getCustomerStats(ticket.customer_id);
      customerInfo = `Customer: ${cust.first_name || ""} ${cust.last_name || ""} (${cust.email}), Subscription: ${cust.subscription_status || "none"}, Retention: ${cust.retention_score || 0}, Orders: ${stats.total_orders}, LTV: $${(stats.ltv_cents / 100).toFixed(0)}`;
    }
  }

  // Build ticket context
  const ticketContext = [
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status}`,
    `Channel: ${ticket.channel}`,
    `Tags: ${(ticket.tags || []).join(", ") || "none"}`,
    `AI turns: ${ticket.ai_turn_count || 0}`,
    ticket.escalation_reason ? `Escalation reason: ${ticket.escalation_reason}` : null,
    customerInfo || null,
    "",
    "--- Ticket Messages ---",
    ...(messages || []).map(m => {
      const prefix = m.author_type === "ai" ? "[AI]" : m.author_type === "system" ? "[System]" : m.direction === "inbound" ? "[Customer]" : "[Agent]";
      const vis = m.visibility === "internal" ? " (internal note)" : "";
      return `${prefix}${vis}: ${m.body?.replace(/<[^>]+>/g, " ").slice(0, 500)}`;
    }),
  ].filter(Boolean).join("\n");

  // Build Claude messages
  const claudeMessages: { role: "user" | "assistant"; content: string }[] = [];

  // Add conversation history
  if (conversationHistory && conversationHistory.length > 0) {
    for (const h of conversationHistory) {
      claudeMessages.push({ role: h.role, content: h.content });
    }
  }

  // Add current message
  claudeMessages.push({
    role: "user",
    content: message,
  });

  // Import data tools from Sonnet orchestrator v2
  const { default: executeToolCallImprove } = await import("@/lib/improve-tools");

  const tools = [
    { name: "get_customer_account", description: "Get customer subscriptions, recent orders, loyalty points, unused coupons, linked accounts. Use to verify charges, check subscription status, etc.", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
    { name: "get_product_knowledge", description: "Get product catalog, macros, KB articles.", input_schema: { type: "object" as const, properties: { query: { type: "string", description: "Search term" } }, required: [] as string[] } },
    { name: "get_returns", description: "Get customer return requests with status and refund details.", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
    { name: "get_chargebacks", description: "Get chargeback/dispute events for this customer.", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
    { name: "get_email_history", description: "Get email delivery history (sent, opened, clicked, bounced).", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
    { name: "get_crisis_status", description: "Get crisis/out-of-stock actions for this customer.", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
    { name: "get_dunning_status", description: "Get payment failure and recovery status.", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
    { name: "get_ticket_analysis", description: "Get the latest AI quality analysis for this ticket — score, issues, summary, and analyst's reasoning. Use this when the admin asks 'why was this graded low?' or wants to see what the grader flagged.", input_schema: { type: "object" as const, properties: {}, required: [] as string[] } },
  ];

  try {
    // Multi-turn tool use loop (max 3 rounds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let aiMessages: any[] = [...claudeMessages];
    let rawText = "";

    for (let round = 0; round < 3; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          // Improve is used infrequently and is the deepest investigation
          // surface — always use the strongest model available.
          model: OPUS_MODEL,
          max_tokens: 2000,
          tools,
          system: `${SYSTEM_PROMPT}\n\n--- TICKET CONTEXT ---\n${ticketContext}`,
          messages: aiMessages,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Anthropic API error:", errText);
        return NextResponse.json({ error: "AI request failed" }, { status: 502 });
      }

      const data = await res.json();
      const content = data.content || [];
      const toolUseBlocks = content.filter((b: { type: string }) => b.type === "tool_use");
      const textBlocks = content.filter((b: { type: string }) => b.type === "text");

      if (toolUseBlocks.length === 0) {
        // No tool calls — done
        rawText = textBlocks.map((b: { text: string }) => b.text).join("");
        break;
      }

      // Execute tool calls
      const toolResults: { type: string; tool_use_id: string; content: string }[] = [];
      for (const toolCall of toolUseBlocks) {
        const result = await executeToolCallImprove(toolCall.name, toolCall.input || {}, workspaceId, ticket);
        toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: result });
      }

      aiMessages = [...aiMessages, { role: "assistant" as const, content }, { role: "user" as const, content: toolResults }];
    }

    if (!rawText) rawText = "I wasn't able to complete the analysis. Please try rephrasing.";

    // Try to parse as JSON
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);

        // Execute actions if type is action_execute
        if (parsed.type === "action_execute" && parsed.proposed_actions?.length) {
          const { runImproveActions } = await import("@/lib/improve-actions");
          const { results } = await runImproveActions(workspaceId, ticketId, parsed.proposed_actions);
          parsed.message = (parsed.message || "") + "\n\nResults:\n" + results.map(r => `• ${r}`).join("\n");
          parsed.action_results = results;
        }

        return NextResponse.json(parsed);
      } catch {
        // Fall through to text response
      }
    }

    return NextResponse.json({
      type: "question",
      message: rawText,
    });
  } catch (err) {
    console.error("Improve endpoint error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
