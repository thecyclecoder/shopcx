import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
          model: "claude-opus-4-7",
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
          // Action context — accumulates outputs (label_url, tracking_number,
          // refund_amount, etc.) so chained send_message can reference them
          // via {{placeholder}} substitution. Same shape as action-executor.
          const actionContext: Record<string, string> = {};

          // CTA button HTML for {{label_url}} substitution. Mirrors the
          // shared ctaButton() in action-executor.ts so customers see the
          // same teal button whether the AI or an admin issued the label.
          const ctaButton = (url: string, label: string): string =>
            `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0;"><tr><td bgcolor="#0f766e" style="background-color:#0f766e;border-radius:8px;"><a href="${url}" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">${label}</a></td></tr></table>`;

          for (const action of parsed.proposed_actions) {
            try {
              switch (action.type) {
                case "partial_refund": {
                  const { partialRefundByAmount } = await import("@/lib/shopify-order-actions");
                  const r = await partialRefundByAmount(workspaceId, action.shopify_order_id, action.amount_cents, action.reason);
                  results.push(r.success ? `Refund of $${(action.amount_cents / 100).toFixed(2)} issued` : `Refund failed: ${r.error}`);
                  if (r.success) actionContext.refund_amount = `$${(action.amount_cents / 100).toFixed(2)}`;
                  break;
                }
                case "create_return": {
                  // Create EasyPost return label for the order. Pulls customer
                  // address from the order, return address from workspace.
                  // After success, label_url + tracking_number flow into any
                  // chained send_message via placeholder substitution.
                  const { data: order } = await admin.from("orders")
                    .select("order_number, shopify_order_id, shipping_address, line_items")
                    .or(`shopify_order_id.eq.${action.shopify_order_id},order_number.eq.${action.shopify_order_id}`)
                    .single();
                  if (!order) { results.push(`create_return: order not found (${action.shopify_order_id})`); break; }
                  const ship = order.shipping_address as Record<string, string> | null;
                  if (!ship?.address1) { results.push(`create_return: order has no shipping address`); break; }
                  const { data: ws } = await admin.from("workspaces")
                    .select("return_address, default_return_parcel").eq("id", workspaceId).single();
                  const returnAddr = ws?.return_address as Record<string, string> | null;
                  const parcel = (ws?.default_return_parcel as { length: number; width: number; height: number; weight: number } | null) || { length: 12, width: 10, height: 6, weight: 16 };
                  if (!returnAddr) { results.push(`create_return: no return_address configured`); break; }

                  const { getEasyPostClient } = await import("@/lib/easypost");
                  const client = await getEasyPostClient(workspaceId);
                  const shipment = await client.Shipment.create({
                    from_address: {
                      name: ship.name || `${ship.first_name || ""} ${ship.last_name || ""}`.trim(),
                      street1: ship.address1, street2: ship.address2 || "",
                      city: ship.city, state: ship.province_code || ship.province,
                      zip: ship.zip, country: ship.country_code || "US",
                      phone: ship.phone || undefined,
                    },
                    to_address: {
                      name: returnAddr.name, street1: returnAddr.street1, street2: returnAddr.street2 || "",
                      city: returnAddr.city, state: returnAddr.state, zip: returnAddr.zip,
                      country: returnAddr.country || "US", phone: returnAddr.phone || undefined,
                    },
                    parcel,
                    is_return: true,
                  });
                  const rates = (shipment.rates || []) as Array<{id: string; carrier: string; service: string; rate: string}>;
                  const usps = rates.filter(r => r.carrier === "USPS").sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate))[0];
                  if (!usps) { results.push(`create_return: no USPS rates`); break; }
                  const bought = await client.Shipment.buy(shipment.id, usps.id);
                  const labelUrl = bought.postage_label?.label_url || "";
                  const tracking = bought.tracking_code || "";
                  actionContext.label_url = labelUrl;
                  actionContext.tracking_number = tracking;
                  actionContext.carrier = "USPS";
                  results.push(`Return label created (${order.order_number}) — tracking ${tracking}, $${parseFloat(usps.rate).toFixed(2)}`);
                  break;
                }
                case "swap_variant": {
                  const { subSwapVariant } = await import("@/lib/subscription-items");
                  const r = await subSwapVariant(workspaceId, action.contract_id, action.old_variant_id, action.new_variant_id, action.quantity || 1);
                  results.push(r.success ? `Variant swapped (${action.old_variant_id} → ${action.new_variant_id})` : `Swap failed: ${r.error}`);
                  break;
                }
                case "change_next_date": {
                  const { appstleUpdateNextBillingDate } = await import("@/lib/appstle");
                  const r = await appstleUpdateNextBillingDate(workspaceId, action.contract_id, action.date);
                  results.push(r.success ? `Next billing date set to ${action.date}` : `Date change failed: ${r.error}`);
                  break;
                }
                case "change_frequency": {
                  const { appstleUpdateBillingInterval } = await import("@/lib/appstle");
                  const r = await appstleUpdateBillingInterval(workspaceId, action.contract_id, action.interval, Number(action.interval_count));
                  results.push(r.success ? `Frequency: every ${action.interval_count} ${action.interval}` : `Frequency failed: ${r.error}`);
                  break;
                }
                case "update_shipping_address": {
                  // Reuses the orchestrator's update_shipping_address action so
                  // the same Shopify+Appstle+Amplifier propagation runs.
                  const { executeSonnetDecision } = await import("@/lib/action-executor");
                  const { data: t } = await admin.from("tickets").select("customer_id, channel").eq("id", ticketId).single();
                  if (!t?.customer_id) { results.push(`update_shipping_address: no customer on ticket`); break; }
                  await executeSonnetDecision(
                    { admin, workspaceId, ticketId, customerId: t.customer_id, channel: t.channel || "email", sandbox: false },
                    {
                      reasoning: "Admin improve: update shipping address",
                      action_type: "direct_action",
                      actions: [{ type: "update_shipping_address", contract_id: action.contract_id, address: action.address }],
                    },
                    null,
                    async () => { /* no customer-facing message — admin's send_message handles it */ },
                    async (m) => {
                      await admin.from("ticket_messages").insert({
                        ticket_id: ticketId, direction: "outbound", visibility: "internal", author_type: "system", body: m,
                      });
                    },
                  );
                  results.push(`Shipping address updated`);
                  break;
                }
                case "propose_sonnet_prompt": {
                  const { data: ins, error } = await admin.from("sonnet_prompts").insert({
                    workspace_id: workspaceId,
                    title: action.title,
                    content: action.content,
                    category: action.category || "rule",
                    enabled: false,        // not loaded into orchestrator until approved
                    status: "proposed",
                    derived_from_ticket_id: ticketId,
                    proposed_at: new Date().toISOString(),
                    sort_order: 200,
                  }).select("id").single();
                  if (error) { results.push(`propose_sonnet_prompt failed: ${error.message}`); break; }
                  results.push(`Proposed sonnet_prompt rule "${action.title}" — review at /dashboard/settings/ai/prompts (id ${ins.id})`);
                  break;
                }
                case "propose_grader_rule": {
                  const { data: ins, error } = await admin.from("grader_prompts").insert({
                    workspace_id: workspaceId,
                    title: action.title,
                    content: action.content,
                    status: "proposed",
                    derived_from_ticket_id: ticketId,
                  }).select("id").single();
                  if (error) { results.push(`propose_grader_rule failed: ${error.message}`); break; }
                  results.push(`Proposed grader rule "${action.title}" — review at /dashboard/settings/ai/grader-rules (id ${ins.id})`);
                  break;
                }
                case "send_message": {
                  // Substitute action-result placeholders before sending.
                  // Uses the same {{label_url}} → CTA button pattern as the
                  // conversation orchestrator.
                  let body = String(action.body || "");
                  if (actionContext.label_url) {
                    const button = ctaButton(actionContext.label_url, "Download your prepaid return label →");
                    body = body.replace(/\{\{\s*label_url\s*\}\}/g, button)
                               .replace(/\[\s*LABEL_URL\s*\]/g, button);
                  }
                  for (const [key, val] of Object.entries(actionContext)) {
                    if (key === "label_url") continue;
                    const lower = `{{\\s*${key}\\s*}}`;
                    const upper = `\\[\\s*${key.toUpperCase()}\\s*\\]`;
                    body = body.replace(new RegExp(lower, "g"), val);
                    body = body.replace(new RegExp(upper, "g"), val);
                  }

                  const { data: wsInfo } = await admin.from("workspaces").select("name, sandbox_mode").eq("id", workspaceId).single();
                  const { data: t } = await admin.from("tickets").select("channel, customer_id, subject, email_message_id").eq("id", ticketId).single();
                  await admin.from("ticket_messages").insert({
                    ticket_id: ticketId, direction: "outbound", visibility: "external",
                    author_type: "system", body, sent_at: new Date().toISOString(),
                  });
                  if (t?.channel === "email" && t.customer_id) {
                    const { data: cust2 } = await admin.from("customers").select("email").eq("id", t.customer_id).single();
                    if (cust2?.email && !wsInfo?.sandbox_mode) {
                      const { sendTicketReply } = await import("@/lib/email");
                      await sendTicketReply({ workspaceId, toEmail: cust2.email, subject: `Re: ${t.subject || "Your request"}`, body, inReplyTo: t.email_message_id, agentName: "Support", workspaceName: wsInfo?.name || "" });
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
