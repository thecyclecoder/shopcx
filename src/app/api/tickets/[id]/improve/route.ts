import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are a support AI assistant for admins. You can do TWO things:

1. **COACH** — When the admin tells you how a ticket was handled wrong, propose a prompt rule to fix it for the future.
2. **ACT** — When the admin tells you to DO something on this ticket (refund, send message, cancel, pause, reactivate, apply coupon, etc.), propose the specific actions. ALWAYS verify before executing.

## For coaching (future improvement):
- Determine if it's a PROMPT RULE (text instruction for AI) or ARCHITECTURE CHANGE (code)
- Propose the rule, ask admin to verify before saving
- Category: rule, approach, knowledge, or tool_hint

## For actions (fix this ticket now):
- Propose specific actions you'll take (e.g. "I'll issue a $30 partial refund on order #SC127585 and send the customer a message")
- List each action clearly
- Wait for admin to say "yes" / "do it" / approve before executing
- After approval, execute and report results

## Response format:
Return JSON:
{
  "type": "prompt" | "architecture" | "question" | "action_proposal" | "action_execute",
  "message": "your conversational response to the admin",
  "proposed_rule": { "title": "...", "content": "...", "category": "rule" },
  "architecture_description": "...",
  "proposed_actions": [{ "type": "partial_refund", "shopify_order_id": "...", "amount_cents": 3000, "reason": "..." }, { "type": "send_message", "body": "..." }]
}

Only include the fields relevant to the type. For action_execute, include the same proposed_actions that were approved.

Available action types: partial_refund(shopify_order_id, amount_cents, reason), send_message(body), update_line_item_price(contract_id, base_price_cents), reactivate(contract_id), apply_coupon(contract_id, code), crisis_pause(contract_id, crisis_action_id), skip_next_order(contract_id), change_frequency(contract_id, interval, interval_count), close_ticket, reopen_ticket.

Category for proposed_rule should be one of: rule, approach, knowledge, tool_hint.`;

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
    .select("id, subject, tags, status, channel, customer_email, handled_by, ai_turn_count, escalation_reason")
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
  if (ticket.customer_email) {
    const { data: cust } = await admin
      .from("customers")
      .select("first_name, last_name, email, subscription_status, retention_score, total_orders, ltv")
      .eq("workspace_id", workspaceId)
      .eq("email", ticket.customer_email)
      .limit(1)
      .single();
    if (cust) {
      customerInfo = `Customer: ${cust.first_name || ""} ${cust.last_name || ""} (${cust.email}), Subscription: ${cust.subscription_status || "none"}, Retention: ${cust.retention_score || 0}, Orders: ${cust.total_orders || 0}, LTV: $${cust.ltv || 0}`;
    }
  }

  // Build ticket context
  const ticketContext = [
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status}`,
    `Channel: ${ticket.channel}`,
    `Tags: ${(ticket.tags || []).join(", ") || "none"}`,
    `Handled by: ${ticket.handled_by || "unassigned"}`,
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
          model: "claude-sonnet-4-20250514",
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
          const results: string[] = [];
          for (const action of parsed.proposed_actions) {
            try {
              switch (action.type) {
                case "partial_refund": {
                  const { partialRefundByAmount } = await import("@/lib/shopify-order-actions");
                  const r = await partialRefundByAmount(workspaceId, action.shopify_order_id, action.amount_cents, action.reason);
                  results.push(r.success ? `Refund of $${(action.amount_cents / 100).toFixed(2)} issued` : `Refund failed: ${r.error}`);
                  break;
                }
                case "send_message": {
                  const { data: wsInfo } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", workspaceId).single();
                  // Get customer email for email channel
                  const { data: t } = await admin.from("tickets").select("channel, customer_id, subject, email_message_id").eq("id", ticketId).single();
                  await admin.from("ticket_messages").insert({
                    ticket_id: ticketId, direction: "outbound", visibility: "external",
                    author_type: "system", body: action.body, sent_at: new Date().toISOString(),
                  });
                  if (t?.channel === "email" && t.customer_id) {
                    const { data: cust2 } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
                    if (cust2?.email && !wsInfo?.sandbox_mode) {
                      const { sendTicketReply } = await import("@/lib/email");
                      await sendTicketReply({ workspaceId, toEmail: cust2.email, subject: `Re: ${t.subject || "Your request"}`, body: action.body, inReplyTo: t.email_message_id, agentName: "Support", workspaceName: wsInfo?.name || "" });
                    }
                  }
                  results.push("Message sent to customer");
                  break;
                }
                case "reactivate": {
                  const { appstleSubscriptionAction } = await import("@/lib/appstle");
                  const r = await appstleSubscriptionAction(workspaceId, action.contract_id, "resume");
                  results.push(r.success ? "Subscription reactivated" : `Reactivation failed: ${r.error}`);
                  break;
                }
                case "update_line_item_price": {
                  const { subUpdateLineItemPrice } = await import("@/lib/subscription-items");
                  const r = await subUpdateLineItemPrice(workspaceId, action.contract_id, action.variant_id || "", action.base_price_cents);
                  results.push(r.success ? `Base price updated to $${(action.base_price_cents / 100).toFixed(2)}` : `Price update failed: ${r.error}`);
                  break;
                }
                case "apply_coupon": {
                  const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
                  const { getAppstleConfig } = await import("@/lib/subscription-items");
                  const config = await getAppstleConfig(workspaceId);
                  if (config) {
                    const r = await applyDiscountWithReplace(config.apiKey, action.contract_id, action.code);
                    results.push(r.success ? `Coupon ${action.code} applied` : `Coupon failed: ${r.error}`);
                  } else results.push("Appstle not configured");
                  break;
                }
                case "skip_next_order": {
                  const { appstleSkipNextOrder } = await import("@/lib/appstle");
                  const r = await appstleSkipNextOrder(workspaceId, action.contract_id);
                  results.push(r.success ? "Next order skipped" : `Skip failed: ${r.error}`);
                  break;
                }
                case "crisis_pause": {
                  const { appstleSubscriptionAction } = await import("@/lib/appstle");
                  const r = await appstleSubscriptionAction(workspaceId, action.contract_id, "pause", "Crisis pause via admin improve");
                  results.push(r.success ? "Subscription paused (crisis)" : `Pause failed: ${r.error}`);
                  break;
                }
                case "close_ticket": {
                  await admin.from("tickets").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", ticketId);
                  results.push("Ticket closed");
                  break;
                }
                case "reopen_ticket": {
                  await admin.from("tickets").update({ status: "open" }).eq("id", ticketId);
                  results.push("Ticket reopened");
                  break;
                }
                default:
                  results.push(`Unknown action: ${action.type}`);
              }
            } catch (err) {
              results.push(`Action ${action.type} error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          // Log actions as internal note
          await admin.from("ticket_messages").insert({
            ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system",
            body: `[Admin Improve] Actions executed:\n${results.map(r => `• ${r}`).join("\n")}`,
          });
          parsed.message = (parsed.message || "") + "\n\nResults:\n" + results.map(r => `• ${r}`).join("\n");
          parsed.action_results = results;
        }

        return NextResponse.json(parsed);
      } catch {
        // Fall through to text response
      }
    }

    // If not valid JSON, treat as a question
    return NextResponse.json({
      type: "question",
      message: rawText,
    });
  } catch (err) {
    console.error("Improve endpoint error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
// force redeploy
