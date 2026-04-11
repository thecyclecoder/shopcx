/**
 * Sonnet Orchestrator — quality-control routing for inbound customer tickets.
 * Builds compressed context, calls Claude Sonnet, parses the routing decision.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveContext } from "@/lib/rag";

// ── Types ──

export interface SonnetDecision {
  reasoning: string;
  action_type:
    | "direct_action"
    | "journey"
    | "playbook"
    | "workflow"
    | "macro"
    | "kb_response"
    | "ai_response"
    | "escalate";
  actions?: {
    type: string;
    contract_id?: string;
    variant_id?: string;
    old_variant_id?: string;
    new_variant_id?: string;
    quantity?: number;
    interval?: string;
    interval_count?: number;
    date?: string;
    code?: string;
    reason?: string;
    tier_index?: number;
    shopify_order_id?: string;
    amount_cents?: number;
    base_price_cents?: number;
    crisis_action_id?: string;
  }[];
  handler_name?: string;
  response_message?: string;
  needs_clarification?: boolean;
  clarification_question?: string;
}

const FALLBACK_DECISION: SonnetDecision = {
  reasoning: "Sonnet orchestrator failed — escalating to human agent",
  action_type: "escalate",
  response_message: "Let me connect you with a team member who can help.",
};

// ── Context builder ──

export async function buildSonnetContext(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  message: string,
  channel: string,
  personality?: { name?: string; tone?: string; sign_off?: string | null } | null,
): Promise<string> {
  const admin = createAdminClient();

  // Parallel DB queries
  const [
    { data: workspace },
    { data: customer },
    { data: subscriptions },
    { data: loyaltyMember },
    { data: redemptions },
    { data: messages },
    { data: journeys },
    { data: playbooks },
    { data: workflows },
    { data: macros },
    ragContext,
    { data: allProducts },
    { data: recentOrders },
    { count: orderCount },
    { data: crisisActions },
    unlinkedMatches,
  ] = await Promise.all([
    admin
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single(),
    admin
      .from("customers")
      .select("first_name, last_name, email")
      .eq("id", customerId)
      .single(),
    admin
      .from("subscriptions")
      .select(
        "id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date",
      )
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .in("status", ["active", "paused", "cancelled"]),
    admin
      .from("loyalty_members")
      .select("id, points_balance")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .maybeSingle(),
    // Redemptions query — needs member_id, resolved after parallel queries
    Promise.resolve({ data: null as { discount_code: string; discount_value: number; expires_at: string }[] | null }),
    admin
      .from("ticket_messages")
      .select("direction, body_clean, body, visibility, author_type")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false })
      .limit(12),
    admin
      .from("journey_definitions")
      .select("name, trigger_intent, description")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true),
    admin
      .from("playbooks")
      .select("name, description")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true),
    admin
      .from("workflows")
      .select("name, template")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true),
    admin
      .from("macros")
      .select("name, category")
      .eq("workspace_id", workspaceId)
      .eq("active", true)
      .limit(30),
    retrieveContext(workspaceId, message, 3),
    admin
      .from("products")
      .select("title, description, variants")
      .eq("workspace_id", workspaceId)
      .eq("status", "active"),
    admin
      .from("orders")
      .select("order_number, total_cents, line_items, created_at, financial_status, shopify_order_id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(3),
    admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId),
    admin
      .from("crisis_customer_actions")
      .select("id, crisis_id, subscription_id, segment, current_tier, tier1_swapped_to, preserved_base_price_cents, exhausted_at, crisis_events(affected_product_title, expected_restock_date, default_swap_title, default_swap_variant_id, available_flavor_swaps, available_product_swaps, tier2_coupon_code, tier2_coupon_percent, status)")
      .eq("customer_id", customerId)
      .is("exhausted_at", null)
      .order("created_at", { ascending: false })
      .limit(1) as any,
    customerId
      ? import("@/lib/account-matching").then(m => m.findUnlinkedMatches(workspaceId, customerId, admin))
      : Promise.resolve([]),
  ]);

  const wsName = workspace?.name || "our store";
  const cName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || "Customer";
  const cEmail = customer?.email || "unknown";

  // Build product price lookup for grandfathered detection
  const productPriceMap = new Map<string, number>(); // variant_id → standard price_cents
  for (const p of allProducts || []) {
    for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) {
      if (v.id && v.price_cents) productPriceMap.set(String(v.id), v.price_cents);
    }
  }

  // Get coupon price floor setting
  const { data: wsSettings } = await admin.from("workspaces")
    .select("coupon_price_floor_pct").eq("id", workspaceId).single();
  const priceFloorPct = wsSettings?.coupon_price_floor_pct ?? 50;

  // Format subscriptions — detect grandfathered pricing
  let subsBlock = "None";
  let hasGrandfathered = false;
  if (subscriptions?.length) {
    subsBlock = subscriptions
      .map((s: any) => {
        const items = (s.items || [])
          .map(
            (i: any) => {
              const effectiveBase = Math.round((i.price_cents || 0) / 0.75);
              const standardPrice = productPriceMap.get(String(i.variant_id));
              const isGrandfathered = standardPrice && effectiveBase < standardPrice;
              if (isGrandfathered) hasGrandfathered = true;
              return `${i.title || "item"}${i.variant_title ? ` (${i.variant_title})` : ""} x${i.quantity || 1} @ $${((i.price_cents || 0) / 100).toFixed(2)}${isGrandfathered ? " [GRANDFATHERED - below standard $" + ((standardPrice || 0) * 0.75 / 100).toFixed(2) + "]" : ""}`;
            },
          )
          .join(", ");
        const next = s.next_billing_date
          ? new Date(s.next_billing_date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })
          : "?";
        return `- ${s.id} | ${s.status} | ${items} | every ${s.billing_interval_count || 1} ${s.billing_interval || "month"} | next: ${next} | contract: ${s.shopify_contract_id || "?"}`;
      })
      .join("\n");
  }

  // Loyalty
  let loyaltyLine = "No loyalty data";
  // Fetch unused loyalty coupons (needs member_id from loyalty query)
  let actualRedemptions = redemptions;
  if (loyaltyMember?.id) {
    const { data: memberRedemptions } = await admin
      .from("loyalty_redemptions")
      .select("discount_code, discount_value, expires_at")
      .eq("member_id", loyaltyMember.id)
      .eq("status", "active")
      .is("used_at", null);
    actualRedemptions = memberRedemptions;
  }

  if (loyaltyMember) {
    const pts = loyaltyMember.points_balance || 0;
    const coupons = (actualRedemptions || [])
      .map((r: any) => {
        const exp = r.expires_at
          ? new Date(r.expires_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })
          : "no exp";
        return `${r.discount_code} ($${r.discount_value}, expires ${exp})`;
      })
      .join(", ");
    loyaltyLine = `${pts} points${coupons ? ` | Unused coupons: ${coupons}` : ""}`;
  }

  // Conversation history (reverse to chronological order)
  // Include system notes about completed actions so Sonnet knows what's been done
  let convoBlock = "";
  const completedActions: string[] = [];
  if (messages?.length) {
    const ordered = [...messages].reverse();
    convoBlock = ordered
      .filter((m: any) => {
        // Include external messages + system notes about actions taken
        if (m.visibility === "external") return true;
        if (m.visibility === "internal" && m.author_type === "system") {
          const body = (m.body || "") as string;
          // Include action completion notes
          if (body.includes("Action completed:") || body.includes("Action failed:") ||
              body.includes("Applied") || body.includes("Added") ||
              body.includes("Redeemed") || body.includes("Removed") || body.includes("Swapped") ||
              body.includes("Skipped") || body.includes("Resumed") || body.includes("Changed") ||
              body.includes("refund") || body.includes("Refund") ||
              body.includes("All done") || body.includes("Here's what we")) {
            completedActions.push(body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200));
            return true;
          }
        }
        return false;
      })
      .map((m: any) => {
        const text = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        const who = m.direction === "inbound" ? "Customer"
          : m.author_type === "system" ? "[System Action]"
          : "Agent";
        return `${who}: ${text}`;
      })
      .join("\n");
  }

  // Handlers — filter out crisis journeys (handled by crisis-specific Sonnet handler)
  const filteredJourneys = (journeys || []).filter(
    (j: any) => !j.trigger_intent?.startsWith("crisis_"),
  );
  const journeyLines = filteredJourneys
    .map((j: any) => `${j.name}: ${j.description || j.trigger_intent}`)
    .join("\n");
  const playbookLines = (playbooks || [])
    .map((p: any) => `${p.name}: ${p.description || ""}`)
    .join("\n");
  const workflowLines = (workflows || [])
    .map((w: any) => `${w.name}: ${w.template}`)
    .join("\n");
  const macroLines = (macros || [])
    .map((m: any) => `${m.name}${m.category ? ` [${m.category}]` : ""}`)
    .join(", ");

  // KB
  const kbLines = ragContext.chunks
    .slice(0, 3)
    .map(
      (c) =>
        `"${c.kb_title}": ${c.chunk_text.slice(0, 100).replace(/\n/g, " ")}`,
    )
    .join("\n- ");

  // Crisis context — full details for Sonnet to handle crisis-related actions
  let crisisBlock = "";
  if (crisisActions?.length) {
    const action = crisisActions[0] as any;
    const ce = action.crisis_events;
    if (ce && ce.status !== "resolved") {
      const restockDate = ce.expected_restock_date
        ? new Date(ce.expected_restock_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "TBD";
      const currentSwap = (action.tier1_swapped_to as { title?: string })?.title || ce.default_swap_title || "unknown";
      const flavorSwaps = (ce.available_flavor_swaps as { variantId: string; title: string }[] || [])
        .map((f: { title: string; variantId: string }) => `"${f.title}" (variant: ${f.variantId})`).join(", ");
      const productSwaps = (ce.available_product_swaps as { productTitle: string; variants: { variantId: string; title: string }[] }[] || [])
        .map((p: { productTitle: string; variants: { variantId: string; title: string }[] }) =>
          `${p.productTitle}: ${p.variants.map(v => `"${v.title}" (variant: ${v.variantId})`).join(", ")}`).join("; ");

      crisisBlock = `
CRISIS CONTEXT (this ticket is related to a product out-of-stock crisis):
- Affected product: ${ce.affected_product_title} (out of stock until ${restockDate})
- Customer was auto-swapped to: ${currentSwap}
- Crisis action ID: ${action.id}
- Subscription ID: ${action.subscription_id}
- Preserved base price: ${action.preserved_base_price_cents ? `$${(action.preserved_base_price_cents / 100).toFixed(2)}` : "not set"}
${flavorSwaps ? `- Available flavor swaps: ${flavorSwaps}` : ""}
${productSwaps ? `- Available product swaps: ${productSwaps}` : ""}
${ce.tier2_coupon_code ? `- Crisis coupon: ${ce.tier2_coupon_code} (${ce.tier2_coupon_percent}% off)` : ""}`;
    }
  }

  // Format recent orders
  let ordersBlock = "None";
  if (recentOrders?.length) {
    ordersBlock = recentOrders
      .map((o: any) => {
        const items = (o.line_items || [])
          .map((i: any) => `${i.title || "item"}${i.variant_title ? ` (${i.variant_title})` : ""} x${i.quantity || 1} @ $${((i.price_cents || 0) / 100).toFixed(2)}`)
          .join(", ");
        const date = new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `- #${o.order_number || "?"} | ${date} | $${((o.total_cents || 0) / 100).toFixed(2)} | ${o.financial_status || "?"} | ${items} | shopify_order_id: ${o.shopify_order_id || "?"}`;
      })
      .join("\n");
  }

  // Out of stock products (inventory < 10)
  const outOfStockItems: string[] = [];
  for (const product of allProducts || []) {
    const variants = (product.variants as { id?: string; title?: string; inventory_quantity?: number }[]) || [];
    for (const v of variants) {
      if (v.inventory_quantity !== undefined && v.inventory_quantity !== null && v.inventory_quantity < 10) {
        outOfStockItems.push(`${product.title}${v.title ? ` — ${v.title}` : ""} (${v.inventory_quantity} in stock)`);
      }
    }
  }
  const inventoryBlock = outOfStockItems.length > 0
    ? `\nOUT OF STOCK / LOW INVENTORY (do NOT tell customers these are available):\n${outOfStockItems.map(i => `- ${i}`).join("\n")}`
    : "";

  // Build prompt
  return `You are a customer support routing engine for ${wsName}. Analyze the customer's message and decide the best action.

CUSTOMER: ${cName} (${cEmail})${(orderCount || 0) > 0 ? ` — ${orderCount} orders` : ""}
SUBSCRIPTIONS:
${subsBlock}
RECENT ORDERS:
${ordersBlock}
LOYALTY: ${loyaltyLine}${inventoryBlock}${crisisBlock}
${unlinkedMatches.length > 0 ? `POTENTIAL LINKED ACCOUNTS (not yet linked): ${unlinkedMatches.map((m: { email: string }) => m.email).join(", ")}` : ""}
OUR PRODUCT CATALOG:
${(allProducts || []).map((p: { title: string; description?: string }) => `- ${p.title}${p.description ? `: ${p.description.slice(0, 100)}` : ""}`).join("\n") || "No products loaded"}

CONVERSATION:
${convoBlock || `Customer: ${message.slice(0, 300)}`}
${completedActions.length > 0 ? `\nACTIONS ALREADY COMPLETED ON THIS TICKET:\n${completedActions.map(a => `- ${a}`).join("\n")}` : ""}

AVAILABLE HANDLERS (use these when customer interaction is needed):
You do NOT build these — you just SELECT the right one and write a personalized lead-in message. The system builds the forms and handles the actions automatically.
Journeys (interactive forms — on chat: lead-in text + embedded form in same message. On email: lead-in text + CTA button to mini-site. You write the lead-in text, the system builds the form automatically):
${journeyLines || "None"}
Playbooks:
${playbookLines || "None"}
Workflows:
${workflowLines || "None"}

DIRECT ACTIONS (use when you can resolve without customer interaction):
Subscription: resume, skip_next_order, change_frequency(interval, count), change_next_date(date), add_item(variant_id, qty), remove_item(variant_id), swap_variant(old_id, new_id, qty), change_quantity(variant_id, qty), update_line_item_price(contract_id, base_price_cents) — updates the crisis-affected line item's price (auto-resolves which item from crisis context)
Refund: partial_refund(shopify_order_id, amount_cents, reason) — issue a partial refund on a Shopify order. Use when a customer was overcharged (e.g. price increased unexpectedly). Compare recent orders to verify the price difference before refunding.
Crisis: crisis_pause(contract_id, crisis_action_id) — pause subscription until restock (auto-resume), crisis_remove(contract_id, variant_id, crisis_action_id) — remove affected item (auto-readd on restock)
Subscription recovery: reactivate(contract_id) — reactivate a cancelled subscription
Loyalty: redeem_points(tier_index), apply_loyalty_coupon(contract_id, code)
Discounts: apply_coupon(contract_id, code), remove_coupon(contract_id)

MACROS:
${macroLines || "None"}

KB MATCHES:
${kbLines ? `- ${kbLines}` : "None"}

PERSONALITY:
${personality ? `Your name is ${personality.name || "Support"}. Tone: ${personality.tone || "friendly and professional"}.${personality.sign_off ? ` Sign off with: ${personality.sign_off}` : ""} Channel: ${channel}.` : `Friendly and professional. Channel: ${channel}.`}
All response_message text MUST match this personality. Keep it concise — max 2 sentences per paragraph, no markdown, mirror the customer's language.

RULES:
- For cancel requests → use cancel_subscription journey (has retention offers)
- For refund/dispute/unwanted charge → use appropriate playbook
- For missing/damaged items → use replacement playbook
- For address changes → use shipping address journey. But if the customer is just asking to CONFIRM or VERIFY their current address (not change it), look it up from their subscription shipping_address or recent order and tell them directly — do NOT launch the journey.
- For account login issues → use account login workflow
- For order tracking → use order tracking workflow
- For simple subscription changes (skip, date, frequency, swap, add, quantity) → execute directly
- For price complaints / overcharges → ALWAYS compare RECENT ORDERS above. Look at the per-item price_cents across orders. If the latest order's item price is higher than the previous order's item price, the customer was overcharged. Calculate the difference (latest_total - previous_total) and issue partial_refund for that amount. Also update_line_item_price with base_price_cents = previous_price / 0.75 (accounts for 25% subscription discount). Do BOTH actions together.
- When fixing an issue that caused a customer to cancel → after resolving the issue, if their subscription status is "cancelled", offer to reactivate it in your response_message. Mention how much you appreciate their loyalty and their order history (use the order count). Don't auto-reactivate — ASK if they'd like you to. If they say yes in a follow-up, use the reactivate action.
- For loyalty coupon application → always allowed, even for grandfathered customers. Check if customer has unused coupons, apply directly.
- For sale/promotional coupons → if any subscription item is marked [GRANDFATHERED], do NOT apply a sale coupon if it would bring the effective price below ${priceFloorPct}% of the standard MSRP. Loyalty coupons are always OK. If a grandfathered customer asks for a sale coupon, explain they already have special pricing locked in and can use their loyalty points instead.
- For account linking → ONLY send the account linking journey if having the linked account's data would help resolve this specific request (e.g. customer needs login but their shopify account is under a different email). Do NOT link just because unlinked accounts exist — only when it's necessary for the task at hand
- For product availability questions → check OUT OF STOCK / LOW INVENTORY above. If the product is listed there, tell the customer it's temporarily unavailable and offer alternatives. Do NOT say it's available if it's out of stock.
- For product/policy questions → use matching macro or KB article, or generate ai_response
- NEVER use subscription actions (resume, skip, change_frequency, swap, etc.) or subscription journeys if the customer has NO subscriptions. Check the SUBSCRIPTIONS section — if it says "None", do NOT suggest subscription management.
- NEVER use order actions or reference order data if the customer has NO orders. Check RECENT ORDERS — if it says "None", do NOT reference orders.
- NEVER cancel a subscription directly — always use the cancel journey
- For general refund requests (returns, disputes, dissatisfaction) → use the appropriate playbook. Only use partial_refund directly for price discrepancy corrections where you can verify the overcharge from order data.
- NEVER re-issue a refund that was already completed. Check ACTIONS ALREADY COMPLETED — if a refund was already issued, acknowledge it in your message but do NOT create another partial_refund action.
- If a previous action failed (e.g. "Action failed: update_line_item_price"), you SHOULD retry that specific action.
- IMPORTANT: Before treating a customer message as a new request, check ACTIONS ALREADY COMPLETED and the conversation history. If the customer is restating, confirming, or thanking you for something already done → respond with a warm "You're all set!" confirmation. Reference what was done with genuine enthusiasm (e.g. "You're all set! I can't wait to hear how you like the Creatine Prime+"). Do NOT ask for clarification or re-execute actions that are already completed.
- If unclear what customer wants AND no matching completed actions → set needs_clarification with a friendly question
- If truly impossible to handle → escalate
- Do NOT escalate just because a customer asks for a "human" — resolve if you can

Return ONLY valid JSON:
{
  "reasoning": "brief explanation",
  "action_type": "direct_action" | "journey" | "playbook" | "workflow" | "macro" | "kb_response" | "ai_response" | "escalate",
  "actions": [{ "type": "...", "contract_id": "...", ... }],
  "handler_name": "name of journey/playbook/workflow/macro if applicable",
  "response_message": "message to send customer (for direct_action confirmations, kb/ai responses, or journey lead-ins)",
  "needs_clarification": false,
  "clarification_question": null
}`;
}

// ── Sonnet caller ──

export async function callSonnetOrchestrator(
  prompt: string,
): Promise<SonnetDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — returning fallback decision");
    return FALLBACK_DECISION;
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
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(
        `Sonnet orchestrator API error: ${res.status}`,
        errText,
      );
      return FALLBACK_DECISION;
    }

    const data = await res.json();
    const text = (
      data.content?.[0] as { type: string; text: string } | undefined
    )?.text?.trim();

    if (!text) {
      console.error("Sonnet orchestrator returned empty response");
      return FALLBACK_DECISION;
    }

    // Extract JSON — handle potential markdown code fences
    const jsonStr = text.replace(/^```json?\s*/, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(jsonStr) as SonnetDecision;

    // Validate required fields
    if (!parsed.reasoning || !parsed.action_type) {
      console.error("Sonnet orchestrator returned invalid decision", parsed);
      return FALLBACK_DECISION;
    }

    return parsed;
  } catch (err) {
    console.error("Sonnet orchestrator failed:", err);
    return FALLBACK_DECISION;
  }
}
