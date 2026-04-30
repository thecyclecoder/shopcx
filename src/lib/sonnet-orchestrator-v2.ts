/**
 * Sonnet Orchestrator v2 — Tool Use
 *
 * Instead of pre-loading all context, Sonnet gets minimal pre-context + tools
 * to fetch data on demand. Two-bucket reasoning: account data vs product knowledge.
 * Crisis is just another data tool, not a separate code path.
 *
 * Data-only tools — actions stay in SonnetDecision → action executor flow.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { retrieveContext } from "@/lib/rag";
import { logAiUsage, type ClaudeUsage } from "@/lib/ai-usage";

const MODEL_IDS = {
  sonnet: "claude-sonnet-4-20250514",
  opus: "claude-opus-4-7",
} as const;
export type OrchestratorModelKey = keyof typeof MODEL_IDS;

type Admin = ReturnType<typeof createAdminClient>;

// ── Types (same as v1 — action executor expects this) ──

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
  reasoning: "Orchestrator error — falling back to escalation",
  action_type: "escalate",
  response_message: "I'm going to look into this and send you an email shortly.",
};

// ── Tool Definitions (Anthropic format) ──

function buildToolDefinitions() {
  return [
    {
      name: "get_customer_account",
      description: "Get customer's subscriptions, recent orders, loyalty points, unused coupons, and linked accounts. Use when the customer's question involves their account, subscription, orders, billing, or loyalty.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_product_knowledge",
      description: "Get product catalog with descriptions, pre-written response macros, and knowledge base articles. Use for product questions, policy questions, or when you need to find the right pre-written response.",
      input_schema: {
        type: "object" as const,
        properties: { query: { type: "string", description: "Search term to focus results (e.g. 'caffeine coffee' or 'return policy')" } },
        required: [] as string[],
      },
    },
    {
      name: "get_returns",
      description: "Get customer's returns AND replacement orders with status, items, tracking, and refund details. Use when customer asks about a return, replacement, exchange, or refund status.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_fraud_cases",
      description: "Get fraud cases and investigations for this customer. Use when customer's account is flagged or there are order holds.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_crisis_status",
      description: "Get crisis/out-of-stock context. Returns BOTH (a) any active workspace-level crisis events with affected/swap variants and coupon, and (b) this customer's enrollment status if they have one. CALL THIS whenever the customer mentions getting the wrong order/wrong item, an out-of-stock product, or anything that could be a crisis-related complaint — even if no crisis tags are on the ticket.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_chargebacks",
      description: "Get chargeback/dispute events for this customer. Use when customer mentions disputes, chargebacks, or unauthorized charges.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_email_history",
      description: "Get email delivery history for this customer. Use when customer says they didn't receive an email or asks about sent communications.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_dunning_status",
      description: "Get payment failure and recovery status. Use when customer has billing issues or payment failures.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
  ];
}

// ── Pre-loaded Context Builder (~300 tokens) ──

function buildPromptSections(prompts: { category: string; title: string; content: string }[]): string {
  const grouped: Record<string, string[]> = {};
  for (const p of prompts) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(`- ${p.content}`);
  }

  const sections: string[] = [];

  if (grouped.approach?.length) {
    sections.push(`APPROACH:\n${grouped.approach.join("\n")}`);
  }

  if (grouped.rule?.length) {
    sections.push(`RULES:\n${grouped.rule.join("\n")}`);
  }

  if (grouped.knowledge?.length) {
    sections.push(`ADDITIONAL KNOWLEDGE:\n${grouped.knowledge.join("\n")}`);
  }

  if (grouped.tool_hint?.length) {
    sections.push(`TOOL HINTS:\n${grouped.tool_hint.join("\n")}`);
  }

  // Fallback if no prompts configured
  if (sections.length === 0) {
    sections.push("APPROACH:\n- Analyze the customer's message, use tools to look up relevant data, then return your decision as JSON.");
  }

  return sections.join("\n\n");
}

async function buildPreContext(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  message: string,
  channel: string,
  personality?: { name?: string; tone?: string; sign_off?: string | null } | null,
  agentContext?: { assigned: boolean; intervened: boolean } | null,
): Promise<string> {
  const admin = createAdminClient();

  const [
    { data: workspace },
    { data: customer },
    { data: ticket },
    { data: messages },
    { data: journeys },
    { data: playbooks },
    { data: workflows },
    { data: dbPrompts },
  ] = await Promise.all([
    admin.from("workspaces").select("name").eq("id", workspaceId).single(),
    customerId
      ? admin.from("customers").select("first_name, last_name, email").eq("id", customerId).single()
      : Promise.resolve({ data: null }),
    admin.from("tickets").select("tags, active_playbook_id, page_context").eq("id", ticketId).single(),
    admin.from("ticket_messages")
      .select("direction, body_clean, body, visibility, author_type")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false })
      .limit(12),
    admin.from("journey_definitions")
      .select("name, trigger_intent, description")
      .eq("workspace_id", workspaceId).eq("is_active", true),
    admin.from("playbooks")
      .select("name, trigger_intents, description")
      .eq("workspace_id", workspaceId).eq("is_active", true),
    admin.from("workflows")
      .select("name, template, trigger_tag")
      .eq("workspace_id", workspaceId).eq("enabled", true),
    admin.from("sonnet_prompts")
      .select("category, title, content")
      .eq("workspace_id", workspaceId).eq("enabled", true)
      .order("category").order("sort_order"),
  ]);

  const wsName = workspace?.name || "our store";
  const cName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || "Customer";
  const cEmail = customer?.email || "unknown";
  const tags = ((ticket?.tags as string[]) || []).join(", ") || "none";
  const activePlaybookId = ticket?.active_playbook_id || null;

  // If active playbook, get its name
  let activePlaybookNote = "";
  if (activePlaybookId) {
    const { data: pb } = await admin.from("playbooks").select("name").eq("id", activePlaybookId).single();
    activePlaybookNote = `\nACTIVE PLAYBOOK: "${pb?.name || "Unknown"}" is in progress on this ticket. If the customer's message is responding to the playbook's question, route to playbook. If they're asking about something else (conversation drift), answer their question instead.`;
  }

  // Conversation history — external messages + action completion notes
  let convoBlock = "";
  if (messages?.length) {
    const ordered = [...messages].reverse();
    convoBlock = ordered
      .filter((m: { visibility: string; author_type: string; body?: string }) => {
        if (m.visibility === "external") return true;
        if (m.visibility === "internal" && m.author_type === "system") {
          const body = (m.body || "") as string;
          if (body.includes("Action completed:") || body.includes("Action failed:") ||
              body.includes("Applied") || body.includes("Added") ||
              body.includes("Redeemed") || body.includes("Removed") || body.includes("Swapped") ||
              body.includes("Skipped") || body.includes("Resumed") || body.includes("Changed") ||
              body.includes("refund") || body.includes("Refund") ||
              body.includes("All done") || body.includes("Here's what we")) {
            return true;
          }
        }
        return false;
      })
      .map((m: { direction: string; author_type: string; body_clean?: string; body?: string }) => {
        const text = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        const who = m.direction === "inbound" ? "Customer"
          : m.author_type === "system" ? "[Action]"
          : "Agent";
        return `${who}: ${text}`;
      })
      .join("\n");
  }

  // Handler names
  const journeyLines = (journeys || [])
    .filter((j: { trigger_intent?: string }) => !j.trigger_intent?.startsWith("crisis_"))
    .map((j: { name: string; trigger_intent?: string; description?: string }) =>
      `- ${j.name} (${j.trigger_intent || "manual"})${j.description ? ` — ${j.description.slice(0, 60)}` : ""}`)
    .join("\n") || "None";

  const playbookLines = (playbooks || [])
    .map((p: { name: string; trigger_intents?: string[]; description?: string }) =>
      `- ${p.name} (${((p.trigger_intents as string[]) || []).join(", ") || "manual"})${p.description ? ` — ${p.description.slice(0, 60)}` : ""}`)
    .join("\n") || "None";

  const workflowLines = (workflows || [])
    .map((w: { name: string; template?: string }) => `- ${w.name} (${w.template || "custom"})`)
    .join("\n") || "None";

  const persBlock = personality
    ? `Your name is ${personality.name || "Support"}. Tone: ${personality.tone || "friendly and professional"}.${personality.sign_off ? ` Sign off with: ${personality.sign_off}` : ""} Channel: ${channel}.`
    : `Friendly and professional. Channel: ${channel}.`;

  return `You are a customer support agent for ${wsName}. Analyze the customer's message and decide the best action.

You have tools to look up data. Use them to gather what you need before making your decision.

CUSTOMER: ${cName} (${cEmail})
TICKET TAGS: ${tags}${activePlaybookNote}${(() => {
  const pc = ticket?.page_context as { product_title?: string; product_handle?: string; page_path?: string } | null;
  if (!pc) return "";
  const parts: string[] = [];
  if (pc.product_title) parts.push(`viewing the ${pc.product_title} product page`);
  else if (pc.product_handle) parts.push(`viewing /products/${pc.product_handle}`);
  else if (pc.page_path) parts.push(`viewing ${pc.page_path}`);
  return parts.length
    ? `\nPAGE CONTEXT: Customer started this chat while ${parts.join(", ")}. If their question is product-related, prioritize that product in your answer.`
    : "";
})()}${agentContext?.assigned ? `
AGENT CONTEXT: This ticket has been handled by a human agent. You should still respond to the customer, but limit your scope: handle positive closures (thank you, goodbye → close ticket with warm response), and for new requests say "We're reviewing your ticket and an agent will be back with you shortly!" Do NOT take direct actions or provide detailed information — just acknowledge and hold.` : ""}

CONVERSATION:
${convoBlock || `Customer: ${message.slice(0, 300)}`}

AVAILABLE HANDLERS (interactive flows you can route customers to — you select them, the system builds the form):
Journeys (on chat: embedded form, on email: CTA button to mini-site):
${journeyLines}
Playbooks (multi-step guided flows with policies):
${playbookLines}
Workflows (automated tasks):
${workflowLines}

PERSONALITY:
${persBlock}

${buildPromptSections(dbPrompts || [])}

When you have enough data, respond with ONLY valid JSON (no tool calls):
{
  "reasoning": "brief explanation",
  "action_type": "direct_action" | "journey" | "playbook" | "workflow" | "macro" | "kb_response" | "ai_response" | "escalate",
  "actions": [{ "type": "...", "contract_id": "...", ... }],
  "handler_name": "name of journey/playbook/workflow if applicable",
  "response_message": "message to send customer",
  "needs_clarification": false,
  "clarification_question": null
}`;
}

// ── Tool Execution ──

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  workspaceId: string,
  customerId: string,
  _ticketId: string,
): Promise<string> {
  const admin = createAdminClient();
  try {
    switch (name) {
      case "get_customer_account":
        return await getCustomerAccount(admin, workspaceId, customerId);
      case "get_product_knowledge":
        return await getProductKnowledge(admin, workspaceId, (input?.query as string) || "");
      case "get_returns":
        return await getReturns(admin, workspaceId, customerId);
      case "get_fraud_cases":
        return await getFraudCases(admin, workspaceId, customerId);
      case "get_crisis_status":
        return await getCrisisStatus(admin, workspaceId, customerId);
      case "get_chargebacks":
        return await getChargebacks(admin, workspaceId, customerId);
      case "get_email_history":
        return await getEmailHistory(admin, workspaceId, customerId);
      case "get_dunning_status":
        return await getDunningStatus(admin, workspaceId, customerId);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error fetching data: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Data Fetcher Functions ──

/**
 * Expand a customer_id to include any linked accounts in the same group.
 * Returns [custId] if not linked, or all sibling customer_ids otherwise.
 *
 * Apply this in EVERY data tool that filters by customer_id — Roxana's
 * ticket revealed that returns/chargebacks/etc. on the linked side
 * become invisible if you only query the primary, leading Sonnet to
 * tell the customer "no return on file" while the return is right
 * there on their other email.
 */
async function resolveLinkedCustomerIds(admin: Admin, custId: string): Promise<string[]> {
  const { data: linkData } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", custId).maybeSingle();
  if (!linkData?.group_id) return [custId];
  const { data: grp } = await admin.from("customer_links")
    .select("customer_id").eq("group_id", linkData.group_id);
  const ids = (grp || []).map(g => g.customer_id);
  return ids.length ? ids : [custId];
}

async function getCustomerAccount(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);

  const [
    { data: subs },
    { data: orders },
    { data: loyaltyMember },
  ] = await Promise.all([
    admin.from("subscriptions")
      .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .in("status", ["active", "paused", "cancelled"])
      .order("created_at", { ascending: false }),
    admin.from("orders")
      .select("order_number, total_cents, line_items, discount_codes, created_at, financial_status, shopify_order_id, fulfillments, source_name")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .order("created_at", { ascending: false }).limit(5),
    admin.from("loyalty_members")
      .select("id, points_balance")
      .eq("workspace_id", wsId).eq("customer_id", custId).maybeSingle(),
  ]);

  const parts: string[] = [];

  // Subscriptions
  if (subs?.length) {
    // Load product prices for grandfathered detection
    const { data: products } = await admin.from("products").select("variants").eq("workspace_id", wsId).eq("status", "active");
    const priceMap = new Map<string, number>();
    for (const p of products || []) {
      for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) {
        if (v.id && v.price_cents) priceMap.set(String(v.id), v.price_cents);
      }
    }

    parts.push("SUBSCRIPTIONS:");
    for (const s of subs) {
      const items = (s.items as { title?: string; variant_title?: string; quantity?: number; variant_id?: string; price_cents?: number }[] || []);
      const itemStr = items.map(i => {
        const msrp = priceMap.get(String(i.variant_id));
        const realized = i.price_cents || 0;
        const qty = i.quantity || 1;
        const tail: string[] = [];
        if (msrp) {
          const standard = Math.round(msrp * 0.75);
          const floor = Math.round(msrp * 0.5);
          const savingsPct = Math.round((1 - realized / msrp) * 100);
          tail.push(`MSRP $${(msrp / 100).toFixed(2)} | standard $${(standard / 100).toFixed(2)} | floor $${(floor / 100).toFixed(2)} | SAVINGS ${savingsPct}% off MSRP`);
          if (realized < floor) tail.push("[BELOW 50% FLOOR — no longer allowed]");
          else if (realized <= floor + 10) tail.push("[AT FLOOR]");
          else if (realized < standard) tail.push("[grandfathered above floor]");
        }
        return `${i.title || "item"}${i.variant_title ? ` (${i.variant_title})` : ""} x${qty} @ $${(realized / 100).toFixed(2)} each (line $${((realized * qty) / 100).toFixed(2)})${tail.length ? ` — ${tail.join(" ")}` : ""}`;
      }).join(", ");
      const next = s.next_billing_date
        ? new Date(s.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        : "?";
      const ageDays = Math.floor((Date.now() - new Date(s.created_at).getTime()) / 86400000);
      const intervalDays = (s.billing_interval === "MONTH" || s.billing_interval === "month")
        ? (s.billing_interval_count || 1) * 30
        : (s.billing_interval_count || 1) * 7;
      const firstRenewal = ageDays < intervalDays;
      parts.push(`- ${s.id} | ${s.status} | ${itemStr} | every ${s.billing_interval_count || 1} ${s.billing_interval || "month"} | next: ${next} | contract: ${s.shopify_contract_id}${firstRenewal ? " [FIRST RENEWAL - never renewed yet]" : ""}`);
    }
  } else {
    parts.push("SUBSCRIPTIONS: None");
  }

  // Orders
  // Per-unit pricing is the only reliable comparison signal — order totals
  // fluctuate with taxes / shipping protection / quantity. We surface:
  //   - realized price: what the customer actually pays per unit (the line price)
  //   - MSRP: the variant's listed retail price (in our products table)
  //   - 50% MSRP floor: the absolute minimum realized price we'll honor
  //   - standard sub price: MSRP × 0.75 (the default 25% subscription discount)
  if (orders?.length) {
    // Pre-load variant MSRPs for orders' line items (used for floor / standard refs)
    const variantIds = new Set<string>();
    for (const o of orders) {
      for (const i of (o.line_items as { variant_id?: string }[] || [])) {
        if (i.variant_id) variantIds.add(String(i.variant_id));
      }
    }
    const msrpMap = new Map<string, number>(); // variant_id → MSRP cents
    if (variantIds.size > 0) {
      const { data: products } = await admin.from("products").select("variants").eq("workspace_id", wsId);
      for (const p of products || []) {
        for (const v of (p.variants as { id?: string; price_cents?: number }[] || [])) {
          if (v.id && v.price_cents != null) msrpMap.set(String(v.id), v.price_cents);
        }
      }
    }

    parts.push("\nRECENT ORDERS:");
    for (const o of orders) {
      const lineItems = (o.line_items as { title?: string; variant_title?: string; quantity?: number; price_cents?: number; sku?: string; variant_id?: string }[] || []);
      const itemStr = lineItems.map(i => {
        const qty = i.quantity || 1;
        const realizedCents = i.price_cents || 0;
        const titleFull = `${i.title || "?"}${i.variant_title ? ` (${i.variant_title})` : ""}`;
        const msrp = i.variant_id ? msrpMap.get(String(i.variant_id)) : undefined;
        if (msrp) {
          const standardCents = Math.round(msrp * 0.75);
          const floorCents = Math.round(msrp * 0.5);
          const flag =
            realizedCents < floorCents ? " [BELOW 50% FLOOR — not allowed anymore]" :
            Math.abs(realizedCents - floorCents) <= 10 ? " [AT FLOOR — minimum allowed]" :
            realizedCents < standardCents ? " [grandfathered, above floor]" :
            "";
          return `${titleFull} x${qty} @ $${(realizedCents / 100).toFixed(2)}/unit realized (MSRP $${(msrp / 100).toFixed(2)} | standard sub $${(standardCents / 100).toFixed(2)} | 50% floor $${(floorCents / 100).toFixed(2)})${flag}`;
        }
        return `${titleFull} x${qty} @ $${(realizedCents / 100).toFixed(2)}/unit realized`;
      }).join(", ");
      const date = new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const fulfillments = (o.fulfillments as { tracking_number?: string; status?: string }[] || []);
      const tracking = fulfillments[0]?.tracking_number ? ` | tracking: ${fulfillments[0].tracking_number}` : "";
      const coupons = (o.discount_codes as string[] | null)?.length ? ` | coupons: ${(o.discount_codes as string[]).join(", ")}` : "";
      const isDraft = (o.source_name as string) === "shopify_draft_order";
      const sourceLabel = isDraft ? " [DRAFT — not a renewal, ignore for price comparisons]" : "";
      parts.push(`- #${o.order_number} | ${date} | total $${((o.total_cents || 0) / 100).toFixed(2)} | ${o.financial_status || "?"}${sourceLabel} | ${itemStr}${coupons}${tracking} | shopify_order_id: ${o.shopify_order_id || "?"}`);
    }
    parts.push(`PRICING TERMINOLOGY (use customer-facing language):
- "Realized price" = what the customer actually pays per unit (the per-unit price on the order). Use this when speaking to customers.
- "Base price" = an internal-only concept (realized / 0.75). NEVER mention "base price" in customer messages.
- MSRP = the variant's listed retail price.
- Standard subscription price = MSRP × 0.75 (the default 25% subscriber discount).
- 50% MSRP floor = the absolute minimum realized price we honor. Customers historically below this floor were raised TO the floor by a cleanup; their old price can no longer be offered.

PRICE COMPARISON RULE: compare per-unit realized prices across orders, never totals. If a renewal's per-unit matches prior renewals → NOT overcharged. If the per-unit went UP from a below-floor historical price to the 50% floor, that's the cleanup raising them to our minimum — explain rather than refund. If a renewal's per-unit went up beyond the 50% floor for no reason, that's a real overcharge worth investigating.

DRAFT ORDERS: orders flagged [DRAFT — not a renewal] are manual draft orders (source: shopify_draft_order). They often show MSRP-based pricing because they're not subject to subscription contract pricing. NEVER use them to argue a customer was overcharged on their actual subscription.`);
  } else {
    parts.push("\nRECENT ORDERS: None");
  }

  // Loyalty
  if (loyaltyMember) {
    parts.push(`\nLOYALTY: ${loyaltyMember.points_balance || 0} points`);

    // Show available redemption tiers so AI only offers real options
    const { data: loyaltyConfig } = await admin.from("loyalty_settings")
      .select("redemption_tiers")
      .eq("workspace_id", wsId)
      .single();
    const tiers = (loyaltyConfig?.redemption_tiers || []) as { label: string; points_cost: number; discount_value: number }[];
    if (tiers.length) {
      const tierList = tiers.map(t => `${t.label} (${t.points_cost} pts → $${t.discount_value} off)`).join(", ");
      parts.push(`Available redemption tiers: ${tierList}`);
      parts.push("IMPORTANT: Only offer these exact tiers — never invent other amounts.");
    }

    const { data: redemptions } = await admin.from("loyalty_redemptions")
      .select("discount_code, discount_value, expires_at")
      .eq("member_id", loyaltyMember.id).eq("status", "active").is("used_at", null);
    if (redemptions?.length) {
      const coupons = redemptions.map((r: { discount_code: string; discount_value: number; expires_at?: string }) => {
        const exp = r.expires_at ? new Date(r.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "no exp";
        return `${r.discount_code} ($${r.discount_value}, expires ${exp})`;
      }).join(", ");
      parts.push(`Unused coupons: ${coupons}`);
    }
  }

  // Linked accounts
  if (allCustIds.length > 1) {
    const linkedIds = allCustIds.filter(id => id !== custId);
    const { data: linkedCusts } = await admin.from("customers")
      .select("email").in("id", linkedIds);
    if (linkedCusts?.length) {
      parts.push(`\nLINKED ACCOUNTS (data above includes these): ${linkedCusts.map(c => c.email).join(", ")}`);
    }
  }

  // Shipping address from customer default_address or latest order
  const { data: custAddr } = await admin.from("customers")
    .select("default_address").eq("id", custId).single();
  const addr = custAddr?.default_address as { address1?: string; address2?: string; city?: string; province?: string; zip?: string; country?: string } | null;
  if (addr?.address1) {
    parts.push(`\nSHIPPING ADDRESS: ${[addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country].filter(Boolean).join(", ")}`);
  } else if (orders?.length) {
    // Try from latest order fulfillment
    const fulfillments = (orders[0].fulfillments as { shipping_address?: string }[] || []);
    if (fulfillments[0]?.shipping_address) {
      parts.push(`\nSHIPPING ADDRESS (from last order): ${fulfillments[0].shipping_address}`);
    }
  }

  // Unlinked potential matches
  const { findUnlinkedMatches } = await import("@/lib/account-matching");
  const unlinked = await findUnlinkedMatches(wsId, custId, admin);
  if (unlinked.length) {
    parts.push(`\nPOTENTIAL UNLINKED ACCOUNTS: ${unlinked.map(m => m.email).join(", ")}`);
  }

  return parts.join("\n");
}

async function getProductKnowledge(admin: Admin, wsId: string, query: string): Promise<string> {
  // Always run RAG search — it finds the most relevant macros + KB from 286+ macros
  const searchQuery = query || "general product information";
  const [
    { data: products },
    ragResults,
  ] = await Promise.all([
    admin.from("products").select("title, description, variants").eq("workspace_id", wsId).eq("status", "active"),
    retrieveContext(wsId, searchQuery, 10),
  ]);

  const parts: string[] = [];

  // Products with inventory
  parts.push("PRODUCT CATALOG:");
  for (const p of products || []) {
    const variants = (p.variants as { title?: string; inventory_quantity?: number }[] || []);
    const oosVariants = variants.filter(v => v.inventory_quantity != null && v.inventory_quantity <= 0);
    const stockNote = oosVariants.length > 0
      ? ` [OUT OF STOCK: ${oosVariants.map(v => v.title || "Default").join(", ")}]`
      : "";
    parts.push(`- ${p.title}${p.description ? `: ${p.description.slice(0, 150)}` : ""}${stockNote}`);
  }

  // Macros from RAG (semantically matched, not brute-force)
  if (ragResults.macros?.length) {
    parts.push("\nMATCHING MACROS (pre-written responses, ranked by relevance):");
    for (const m of ragResults.macros) {
      const body = (m.body_html || m.body_text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      parts.push(`- [${m.category || "general"}] ${m.name}: ${body}`);
    }
  }

  // KB from RAG
  if (ragResults.chunks?.length) {
    parts.push("\nKNOWLEDGE BASE MATCHES:");
    for (const chunk of ragResults.chunks) {
      const content = (chunk.chunk_text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      parts.push(`- "${chunk.kb_title || "Article"}": ${content}`);
    }
  }

  if (!ragResults.macros?.length && !ragResults.chunks?.length) {
    parts.push("\nNo matching macros or KB articles found for this query.");
  }

  return parts.join("\n");
}

async function getReturns(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const parts: string[] = [];

  // Returns
  const { data: returns } = await admin.from("returns")
    .select("id, status, order_number, return_line_items, net_refund_cents, tracking_number, carrier, shipped_at, delivered_at, refunded_at, created_at")
    .eq("workspace_id", wsId).in("customer_id", allCustIds)
    .order("created_at", { ascending: false }).limit(5);

  if (returns?.length) {
    parts.push("RETURNS:");
    for (const r of returns) {
      const items = (r.return_line_items as { title?: string; quantity?: number }[] || []).map(i => `${i.title || "item"} x${i.quantity || 1}`).join(", ");
      const date = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const refund = r.net_refund_cents ? `$${(r.net_refund_cents / 100).toFixed(2)}` : "pending";
      parts.push(`- ${date} | Status: ${r.status} | Order #${r.order_number || "?"} | Items: ${items} | Refund: ${refund}${r.tracking_number ? ` | Tracking: ${r.tracking_number} (${r.carrier || "?"})` : ""}${r.shipped_at ? ` | Shipped: ${new Date(r.shipped_at).toLocaleDateString()}` : ""}${r.delivered_at ? ` | Delivered: ${new Date(r.delivered_at).toLocaleDateString()}` : ""}${r.refunded_at ? ` | Refunded: ${new Date(r.refunded_at).toLocaleDateString()}` : ""}`);
    }
  } else {
    parts.push("RETURNS: No return requests found for this customer.");
  }

  // Replacements (also fan out across linked accounts)
  const { data: replacements } = await admin.from("replacements")
    .select("id, status, original_order_number, items, reason, shopify_replacement_order_name, created_at")
    .eq("workspace_id", wsId).in("customer_id", allCustIds)
    .order("created_at", { ascending: false }).limit(5);

  if (replacements?.length) {
    parts.push("\nREPLACEMENT ORDERS:");
    for (const r of replacements) {
      const items = (r.items as { title?: string; type?: string; quantity?: number }[] || []).map(i => `${i.title || "item"} (${i.type || "replacement"})`).join(", ");
      const date = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      parts.push(`- ${date} | Status: ${r.status} | Original order: #${r.original_order_number || "?"} | Items: ${items} | Reason: ${r.reason || "?"}${r.shopify_replacement_order_name ? ` | Replacement order: ${r.shopify_replacement_order_name}` : ""}`);
    }
  } else {
    parts.push("\nREPLACEMENT ORDERS: No replacement orders found for this customer.");
  }

  return parts.join("\n");
}

async function getFraudCases(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const { data: cases } = await admin.from("fraud_cases")
    .select("id, severity, status, rules_matched, created_at")
    .eq("workspace_id", wsId).in("customer_id", allCustIds)
    .order("created_at", { ascending: false }).limit(5);

  if (!cases?.length) return "No fraud cases for this customer.";

  const parts = ["FRAUD CASES:"];
  for (const c of cases) {
    const date = new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const rules = (c.rules_matched as string[] || []).join(", ");
    parts.push(`- ${date} | ${c.severity} | ${c.status} | Rules: ${rules || "none"}`);
  }
  return parts.join("\n");
}

async function getCrisisStatus(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const [{ data: actions }, { data: workspaceCrises }] = await Promise.all([
    admin.from("crisis_customer_actions")
      .select("id, crisis_id, subscription_id, segment, current_tier, tier1_response, tier1_swapped_to, tier2_response, tier2_swapped_to, tier3_response, paused_at, removed_item_at, auto_resume, auto_readd, cancelled, exhausted_at, preserved_base_price_cents, original_item")
      .in("customer_id", allCustIds)
      .order("created_at", { ascending: false })
      .limit(3),
    admin.from("crisis_events")
      .select("id, name, status, affected_product_title, affected_variant_id, affected_sku, default_swap_title, default_swap_variant_id, tier2_coupon_code, tier2_coupon_percent, expected_restock_date")
      .eq("workspace_id", wsId)
      .eq("status", "active"),
  ]);

  const out: string[] = [];

  // Workspace-level active crises — Sonnet needs to see these even if the
  // customer isn't enrolled, so it can detect "wrong item" complaints
  // caused by an auto-swap and route them to crisis_enroll.
  if (workspaceCrises?.length) {
    out.push("ACTIVE WORKSPACE CRISES:");
    for (const c of workspaceCrises) {
      out.push(`- Crisis "${c.name}" (id ${c.id}) — ${c.affected_product_title || "?"}`);
      out.push(`  Affected variant: ${c.affected_variant_id} (sku ${c.affected_sku || "?"})`);
      if (c.default_swap_variant_id) out.push(`  Customers were auto-swapped to: ${c.default_swap_title} (${c.default_swap_variant_id})`);
      if (c.expected_restock_date) out.push(`  Expected restock: ${c.expected_restock_date}`);
      if (c.tier2_coupon_code) out.push(`  Apology coupon available: ${c.tier2_coupon_code} (${c.tier2_coupon_percent}% off)`);
    }
    out.push("");
  } else {
    out.push("No active workspace crises.");
    out.push("");
  }

  if (!actions?.length) {
    out.push("This customer has no crisis enrollment.");
    if (workspaceCrises?.length) {
      out.push("→ If their recent order shows the swap variant above and they're complaining about a wrong item, enroll them via crisis_enroll direct action (sets auto_readd=true so they get the original product back when crisis resolves).");
    }
    return out.join("\n");
  }

  out.push("CRISIS STATUS (this customer):");
  for (const a of actions) {
    // Get crisis event details
    const { data: crisis } = await admin.from("crisis_events")
      .select("affected_product_title, expected_restock_date, default_swap_title, default_swap_variant_id, available_flavor_swaps, available_product_swaps, tier2_coupon_code, tier2_coupon_percent, status")
      .eq("id", a.crisis_id).single();

    if (!crisis) continue;

    out.push(`Crisis: ${crisis.affected_product_title || "Unknown product"} (${crisis.status})`);
    out.push(`  Expected restock: ${crisis.expected_restock_date || "TBD"}`);
    out.push(`  Segment: ${a.segment} | Current tier: ${a.current_tier} | Crisis action ID: ${a.id}`);
    out.push(`  Subscription ID: ${a.subscription_id}`);
    if (a.original_item) out.push(`  Original item: ${JSON.stringify(a.original_item)}`);
    if (a.tier1_response) out.push(`  Tier 1: ${a.tier1_response}${a.tier1_swapped_to ? ` → ${JSON.stringify(a.tier1_swapped_to)}` : ""}`);
    if (a.tier2_response) out.push(`  Tier 2: ${a.tier2_response}${a.tier2_swapped_to ? ` → ${JSON.stringify(a.tier2_swapped_to)}` : ""}`);
    if (a.tier3_response) out.push(`  Tier 3: ${a.tier3_response}`);
    if (a.paused_at) out.push(`  PAUSED at ${new Date(a.paused_at).toLocaleDateString()} (auto_resume: ${a.auto_resume})`);
    if (a.removed_item_at) out.push(`  REMOVED at ${new Date(a.removed_item_at).toLocaleDateString()} (auto_readd: ${a.auto_readd})`);
    if (a.cancelled) out.push("  CANCELLED");
    if (a.exhausted_at) out.push("  All tiers exhausted");

    // Available swaps
    if (crisis.default_swap_title) out.push(`  Default swap: ${crisis.default_swap_title} (${crisis.default_swap_variant_id})`);
    const flavors = (crisis.available_flavor_swaps as { title: string; variantId: string }[] || []);
    if (flavors.length) out.push(`  Flavor swaps: ${flavors.map(f => `${f.title} (${f.variantId})`).join(", ")}`);
    const products = (crisis.available_product_swaps as { productTitle: string; variants: { title: string; variantId: string }[] }[] || []);
    if (products.length) out.push(`  Product swaps: ${products.map(p => `${p.productTitle}: ${p.variants.map(v => v.title).join(", ")}`).join("; ")}`);
    if (crisis.tier2_coupon_code) out.push(`  Coupon: ${crisis.tier2_coupon_code} (${crisis.tier2_coupon_percent}% off)`);
  }

  return out.join("\n");
}

async function getChargebacks(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const { data: events } = await admin.from("chargeback_events")
    .select("id, reason, status, amount_cents, created_at, shopify_order_id")
    .eq("workspace_id", wsId).in("customer_id", allCustIds)
    .order("created_at", { ascending: false }).limit(5);

  if (!events?.length) return "No chargeback events for this customer.";

  const parts = ["CHARGEBACKS:"];
  for (const e of events) {
    const date = new Date(e.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    parts.push(`- ${date} | ${e.status} | ${e.reason || "unknown"} | $${((e.amount_cents || 0) / 100).toFixed(2)} | Order: ${e.shopify_order_id || "?"}`);
  }
  return parts.join("\n");
}

async function getEmailHistory(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const { data: events } = await admin.from("email_events")
    .select("event_type, subject, occurred_at, metadata")
    .eq("workspace_id", wsId).in("customer_id", allCustIds)
    .order("occurred_at", { ascending: false }).limit(10);

  if (!events?.length) return "No email history for this customer.";

  const parts = ["EMAIL HISTORY:"];
  for (const e of events) {
    const date = new Date(e.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    parts.push(`- ${date}: ${e.event_type} — "${e.subject || "unknown"}"`);
  }
  return parts.join("\n");
}

async function getDunningStatus(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const [
    { data: cycles },
    { data: failures },
  ] = await Promise.all([
    admin.from("dunning_cycles")
      .select("id, subscription_id, status, cycle_number, created_at")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .order("created_at", { ascending: false }).limit(3),
    admin.from("payment_failures")
      .select("id, attempt_type, result, card_last4, created_at")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .order("created_at", { ascending: false }).limit(5),
  ]);

  if (!cycles?.length && !failures?.length) return "No dunning or payment failure data for this customer.";

  const parts: string[] = [];
  if (cycles?.length) {
    parts.push("DUNNING CYCLES:");
    for (const c of cycles) {
      parts.push(`- Subscription ${c.subscription_id} | Cycle #${c.cycle_number} | Status: ${c.status} | ${new Date(c.created_at).toLocaleDateString()}`);
    }
  }
  if (failures?.length) {
    parts.push("\nPAYMENT FAILURES:");
    for (const f of failures) {
      parts.push(`- ${new Date(f.created_at).toLocaleDateString()} | ${f.attempt_type} | ${f.result} | Card: *${f.card_last4 || "?"}`);
    }
  }
  return parts.join("\n");
}

// ── Main Orchestrator ──

export async function callSonnetOrchestratorV2(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  message: string,
  channel: string,
  personality?: { name?: string; tone?: string; sign_off?: string | null } | null,
  agentContext?: { assigned: boolean; intervened: boolean } | null,
  modelChoice?: { model: OrchestratorModelKey; reason: string } | null,
): Promise<SonnetDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    return FALLBACK_DECISION;
  }
  const modelKey: OrchestratorModelKey = modelChoice?.model || "sonnet";
  const modelId = MODEL_IDS[modelKey];
  const purpose = `orchestrator-decision:${modelKey}(${modelChoice?.reason || "default"})`;
  const logUsage = (usage: ClaudeUsage | undefined, tag: string) => {
    void logAiUsage({ workspaceId, model: modelId, usage, purpose: `${purpose}:${tag}`, ticketId });
  };

  try {
    const preContext = await buildPreContext(workspaceId, ticketId, customerId, message, channel, personality, agentContext);
    const tools = buildToolDefinitions();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messages: any[] = [
      { role: "user", content: preContext },
    ];

    const MAX_ROUNDS = 3;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 2000,
          tools,
          messages,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        // Retry once on 529 (overloaded) after 2s delay
        if (res.status === 529) {
          console.warn(`Orchestrator (${modelKey}): 529 overloaded, retrying in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          const retry = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
            body: JSON.stringify({ model: modelId, max_tokens: 2000, tools, messages }),
          });
          if (retry.ok) {
            const retryData = await retry.json();
            logUsage(retryData.usage, `round${round}-retry529`);
            // Replace content blocks and continue processing this round
            const retryContent = retryData.content || [];
            const retryToolUse = retryContent.filter((b: { type: string }) => b.type === "tool_use");
            const retryText = retryContent.filter((b: { type: string }) => b.type === "text");
            if (retryToolUse.length === 0) {
              return parseSonnetDecision(retryText.map((b: { text: string }) => b.text).join(""));
            }
            // Has tool calls — execute them and continue the loop
            const retryResults: unknown[] = [];
            for (const tc of retryToolUse) {
              const result = await executeToolCall(tc.name, tc.input || {}, workspaceId, customerId, ticketId);
              retryResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
            }
            messages.push({ role: "assistant", content: retryContent });
            messages.push({ role: "user", content: retryResults });
            continue;
          }
        }
        console.error(`Orchestrator (${modelKey}) API error: ${res.status}`, errBody.slice(0, 300));
        return { ...FALLBACK_DECISION, reasoning: `${modelKey} API error ${res.status}: ${errBody.slice(0, 100)}` };
      }

      const data = await res.json();
      logUsage(data.usage, `round${round}`);
      const content = data.content || [];

      // Check for tool_use blocks
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textBlocks = content.filter((b: any) => b.type === "text");

      if (toolUseBlocks.length === 0) {
        // No tool calls — Sonnet is done, parse as JSON
        const text = textBlocks.map((b: { text: string }) => b.text).join("");
        return parseSonnetDecision(text);
      }

      // Execute tool calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults: any[] = [];
      for (const toolCall of toolUseBlocks) {
        const result = await executeToolCall(
          toolCall.name,
          toolCall.input || {},
          workspaceId,
          customerId,
          ticketId,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result,
        });
      }

      // Add assistant response + tool results to conversation
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
    }

    // Max rounds exceeded — force a final response without tools
    console.warn(`Orchestrator (${modelKey}): max tool rounds exceeded, forcing final response`);
    try {
      const forceRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 2000,
          messages: [...messages, { role: "user", content: "You have gathered enough data. Based on what you know, provide your decision NOW as JSON. Do not call any more tools." }],
          // No tools — forces text response
        }),
      });
      if (forceRes.ok) {
        const forceData = await forceRes.json();
        logUsage(forceData.usage, "force-decision");
        const text = (forceData.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
        if (text) return parseSonnetDecision(text);
      }
    } catch { /* fall through to fallback */ }
    return FALLBACK_DECISION;
  } catch (err) {
    console.error(`Orchestrator (${modelKey}) error:`, err);
    return { ...FALLBACK_DECISION, reasoning: `${modelKey} error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── JSON Parser ──

function parseSonnetDecision(text: string): SonnetDecision {
  try {
    // Strip markdown code fences if present
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("Sonnet v2: no JSON found in response");
      return FALLBACK_DECISION;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.reasoning || !parsed.action_type) {
      console.error("Sonnet v2: missing required fields");
      return FALLBACK_DECISION;
    }

    return parsed as SonnetDecision;
  } catch (err) {
    console.error("Sonnet v2: JSON parse error:", err);
    return FALLBACK_DECISION;
  }
}
