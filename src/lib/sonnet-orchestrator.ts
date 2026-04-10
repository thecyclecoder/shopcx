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
      .select("name, email")
      .eq("id", customerId)
      .single(),
    admin
      .from("subscriptions")
      .select(
        "id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date",
      )
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .in("status", ["active", "paused"]),
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
      .from("crisis_customer_actions")
      .select("crisis_event_id, crisis_events(affected_product_title, estimated_restock_date)")
      .eq("customer_id", customerId)
      .eq("status", "active") as any,
    customerId
      ? import("@/lib/account-matching").then(m => m.findUnlinkedMatches(workspaceId, customerId, admin))
      : Promise.resolve([]),
  ]);

  const wsName = workspace?.name || "our store";
  const cName = customer?.name || "Customer";
  const cEmail = customer?.email || "unknown";

  // Format subscriptions
  let subsBlock = "None";
  if (subscriptions?.length) {
    subsBlock = subscriptions
      .map((s: any) => {
        const items = (s.items || [])
          .map(
            (i: any) =>
              `${i.title || "item"}${i.variant_title ? ` (${i.variant_title})` : ""} x${i.quantity || 1}`,
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
          if (body.includes("Action completed:") || body.includes("Applied") || body.includes("Added") ||
              body.includes("Redeemed") || body.includes("Removed") || body.includes("Swapped") ||
              body.includes("Skipped") || body.includes("Resumed") || body.includes("Changed") ||
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

  // Crisis
  let crisisLine = "";
  if (crisisActions?.length) {
    const first = crisisActions[0] as any;
    const ce = first.crisis_events;
    if (ce) {
      const restockDate = ce.estimated_restock_date
        ? new Date(ce.estimated_restock_date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })
        : "TBD";
      crisisLine = `\nCRISIS: affected product "${ce.affected_product_title}" is out of stock until ${restockDate} — if relevant to their message`;
    }
  }

  // Build prompt
  return `You are a customer support routing engine for ${wsName}. Analyze the customer's message and decide the best action.

CUSTOMER: ${cName} (${cEmail})
SUBSCRIPTIONS:
${subsBlock}
LOYALTY: ${loyaltyLine}${crisisLine}
${unlinkedMatches.length > 0 ? `POTENTIAL LINKED ACCOUNTS (not yet linked): ${unlinkedMatches.map((m: { email: string }) => m.email).join(", ")}` : ""}
CONVERSATION:
${convoBlock || `Customer: ${message.slice(0, 300)}`}
${completedActions.length > 0 ? `\nACTIONS ALREADY COMPLETED ON THIS TICKET:\n${completedActions.map(a => `- ${a}`).join("\n")}` : ""}

AVAILABLE HANDLERS (use these when customer interaction is needed):
Journeys:
${journeyLines || "None"}
Playbooks:
${playbookLines || "None"}
Workflows:
${workflowLines || "None"}

DIRECT ACTIONS (use when you can resolve without customer interaction):
Subscription: resume, skip_next_order, change_frequency(interval, count), change_next_date(date), add_item(variant_id, qty), remove_item(variant_id), swap_variant(old_id, new_id, qty), change_quantity(variant_id, qty)
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
- For address changes → use shipping address journey
- For account login issues → use account login workflow
- For order tracking → use order tracking workflow
- For simple subscription changes (skip, date, frequency, swap, add, quantity) → execute directly
- For loyalty coupon application → check if customer has unused coupons, apply directly
- For account linking → ONLY send the account linking journey if having the linked account's data would help resolve this specific request (e.g. customer needs login but their shopify account is under a different email). Do NOT link just because unlinked accounts exist — only when it's necessary for the task at hand
- For product/policy questions → use matching macro or KB article, or generate ai_response
- NEVER cancel a subscription directly — always use the cancel journey
- NEVER issue refunds directly — always use the appropriate playbook
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
        max_tokens: 600,
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
