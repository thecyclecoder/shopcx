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
import { errText } from "@/lib/error-text";
import { retrieveContext } from "@/lib/rag";
import { getShopifyOnHandByVariant } from "@/lib/inventory/read";
import { logAiUsage, type ClaudeUsage } from "@/lib/ai-usage";
import { SONNET_MODEL, HAIKU_MODEL } from "@/lib/ai-models";
import { renderDirectionSystemPrompt, prefixDirectionContextReasoning } from "@/lib/ai-context";
import type { TicketDirection } from "@/lib/ticket-directions";
import { buildCustomerTimeline, timelineToText } from "@/lib/customer-timeline";
import { currentDateContext } from "@/lib/ai-date-context";
import { formatSupplementFactsText, type SupplementFactsShape } from "@/lib/product-intelligence/publish";
import { emitInlineAgentHeartbeat } from "@/lib/control-tower/heartbeat";
import { INLINE_AGENT_IDS } from "@/lib/control-tower/registry";
import { AnthropicDependencyError, isRetryableAnthropicStatus, isRetryableThrownError } from "@/lib/anthropic-retry";
import { LOYALTY_REMEDY_MAX_CENTS } from "@/lib/loyalty";

const MODEL_IDS = {
  sonnet: SONNET_MODEL,
  // Founder directive (2026-07-10): the orchestrator NEVER runs on Opus — the tiers are Sonnet + Haiku
  // (see [[model-picker]]). Opus removed from the orchestrator model map.
  // Phase 3 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md — the
  // model-picker's fresh-Direction route returns 'haiku' when the ticket has a
  // fresh + high-confidence + stateless Direction, so the orchestrator must
  // recognise the tier to actually route the call.
  haiku: HAIKU_MODEL,
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
  // ── Resolution-record fields (Phase 2 of ticket-resolution-events
  // -writeahead-ledger-and-decision-schema-extension) ──
  // All optional so parseSonnetDecision stays backward-compatible: a
  // model that omits them still executes, but a WARN is logged so we
  // can watch adoption (see parseSonnetDecision below). The write-ahead
  // ledger row on [[../tables/ticket_resolution_events]] persists these
  // per-turn — problem/confidence/options/chosen — for M1's inline
  // verify block, M2's confidence-gated clarify, and M4's compiler loop.
  problem?: string;
  confidence?: number;
  options?: Array<{
    label: string;
    action_shape?: unknown;
    expected_effect?: string;
  }>;
  chosen?: { option_index: number; why: string };
}

const FALLBACK_DECISION: SonnetDecision = {
  reasoning: "Orchestrator error — falling back to escalation",
  action_type: "escalate",
  response_message: "Someone on my team is working on this and will send you an email shortly!",
};

// When the orchestrator parse-fails on a cancel-intent message, the
// generic escalation boilerplate ("we'll get back to you") is the
// worst possible response — it overpromises human follow-up and the
// customer doesn't get the cancel journey until someone manually
// recovers the ticket. Detect cancel intent on the raw message and
// route to the cancel journey directly instead.
function containsCancelIntent(message: string): boolean {
  if (!message) return false;
  return /\b(cancel(?:l?ed|ling|lation)?|unsubscribe|terminate\s+(?:my\s+)?subscription|end\s+(?:my\s+)?subscription|stop\s+(?:my\s+)?subscription|please\s+cancel)\b/i.test(message);
}

// Every degraded/error path (no API key, API error, parse fail, max-rounds, throw) funnels
// through fallbackWithCancelRoute. Tag each result here so the control-tower heartbeat (Phase 2
// of control-tower-agent-coverage) can mark the run ok:false — the orchestrator "ran but
// produced nothing useful". A real model decision (incl. a model-chosen escalate) is NOT tagged.
const DEGRADED_DECISIONS = new WeakSet<SonnetDecision>();

function fallbackWithCancelRoute(message: string, reason: string): SonnetDecision {
  let decision: SonnetDecision;
  if (containsCancelIntent(message)) {
    decision = {
      reasoning: `${reason} — cancel intent detected on inbound, routing to cancel journey instead of generic escalation`,
      action_type: "journey",
      handler_name: "cancel_subscription",
      response_message:
        "Sorry to hear you're thinking about cancelling. Let me share a couple of options before you go.",
    };
  } else {
    decision = { ...FALLBACK_DECISION, reasoning: reason };
  }
  DEGRADED_DECISIONS.add(decision);
  return decision;
}

// ── Tool Definitions (Anthropic format) ──

function buildToolDefinitions() {
  return [
    {
      name: "get_customer_account",
      description: "Get customer's subscriptions, recent orders, loyalty points, unused coupons, and linked accounts. Use when the customer's question involves their account, subscription, orders, billing, or loyalty.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_customer_timeline",
      description: "Get a chronological 60-day timeline of orders, fulfillments, subscription changes (variant swaps, pauses, frequency changes), payments, and returns — PLUS pre-computed anomaly flags that surface contradictions between customer narrative and ground truth (e.g. 'subscription was changed after order entered fulfillment'). USE THIS FIRST whenever the customer says something that contradicts what they expect: 'I didn't order X', 'I changed it but...', 'why am I being charged', 'where's my order', 'I cancelled but...'. The anomalies section will save you from accepting a wrong customer framing.",
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
      name: "get_product_nutrition",
      description: "Get per-variant Supplement Facts / nutrition for products that have them: serving size, servings per container, each nutrient with its amount and % daily value, the proprietary blend, footer notes, and the 'other ingredients' line. CALL THIS for any nutrition question — calories, sodium, potassium, sugar, carbs, protein, fiber, caffeine amount, ingredient amounts/dosages, 'supplement facts', macros, or whether a product fits a diet (keto, low-sodium, diabetic, etc.). Returns the facts per flavor/variant, so you can quote the exact number for the flavor the customer asks about. Only products with published facts appear — if a product isn't listed, we don't have verified facts for it (say so, don't guess).",
      input_schema: {
        type: "object" as const,
        properties: { query: { type: "string", description: "Product or flavor/variant name to focus on (e.g. 'Superfood Tabs', 'Peach Mango'). Omit to list every product/variant that has facts." } },
        required: [] as string[],
      },
    },
    {
      name: "check_inventory",
      description: "Check CURRENT stock levels for products/variants. Returns each matching variant's on-hand quantity and in-stock vs OUT OF STOCK status, plus a full list of every out-of-stock item in the catalog and any expected restock dates. CALL THIS whenever a customer says an item is MISSING from their order, they DIDN'T RECEIVE a product, asks 'is X in stock / available', or before promising a reship/replacement — an out-of-stock item is omitted from fulfillment (and not charged), so confirm stock before saying you'll 'make it right'. Covers single-SKU products that get_product_knowledge hides. Pass the product name from the customer's order (e.g. 'Apple Cider Vinegar Gummies').",
      input_schema: {
        type: "object" as const,
        properties: { query: { type: "string", description: "Product or variant name to check (e.g. 'ACV Gummies', 'Mixed Berry'). Omit to list everything currently out of stock." } },
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
    {
      name: "get_payment_methods",
      description: "Get the cards/payment methods the customer has on file (both our local Braintree-vaulted cards from storefront checkout AND Shopify Payments cards). Use when the customer asks about which cards we have, wants to change/default/delete a card, or mentions a specific card by last4. Returns brand, last4, expiry, default flag, and revocation status for each.",
      input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
    },
    {
      name: "get_order_refund_ledger",
      description: "Get the LIVE refund ledger for ONE order, read directly from Shopify's transaction list (source of truth) and reconciled against our local refund mirror. Returns `saleCents` (what the customer was charged), `refundedCents` (settled refunds), `pendingCents` (gateway-pending refunds still settling), `refundableCents` (the CEILING for any new refund on this order right now — max(0, sale − refunded − pending)), and `outOfBandCents` (settled Shopify refunds NOT in our local mirror — someone refunded outside ShopCX). CALL THIS whenever the customer disputes a refund amount, asks 'how much can I still get refunded', mentions a refund they got outside our system, or you're about to propose/quote a refund — `refundableCents` is the ceiling for any refund on that order, and `outOfBandCents > 0` means someone refunded outside ShopCX (usually a manual refund in the Shopify admin) and our internal refund-owed math will be wrong until you use this reading. Pass the human `order_number` (e.g. 'SC133086') from RECENT ORDERS.",
      input_schema: {
        type: "object" as const,
        properties: {
          order_number: {
            type: "string",
            description: "The customer-facing order number (e.g. 'SC133086'). Take it from RECENT ORDERS in get_customer_account.",
          },
        },
        required: ["order_number"] as string[],
      },
    },
  ];
}

// ── Pre-loaded Context Builder (~300 tokens) ──

/**
 * Emit active policies as a single POLICIES: block at the top of the
 * rule-set. These are the canonical source of truth for refunds, returns,
 * subscriptions, exchanges, and crisis handling — they replace ~60 scattered
 * prompts that previously paraphrased the same rules and drifted (a
 * contradiction between two such prompts caused the same-day-void incident
 * on 2026-05-26).
 *
 * Reads `internal_summary` from each active policy row. The customer_summary
 * field is reserved for the storefront /policies/{slug} page and is NOT
 * surfaced here.
 */
function buildPoliciesSection(policies: { slug: string; name: string; internal_summary: string }[]): string {
  if (!policies.length) return "";
  const blocks = policies.map(p => `## ${p.name} (slug: ${p.slug})\n${p.internal_summary}`).join("\n\n");
  return `POLICIES (canonical — these supersede any conflicting older rule below):\n${blocks}`;
}

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

/**
 * Tail-rollup trigger for a merged ticket's "since window" (Phase 2 of
 * ticket-merge-summary-and-context-cap). When the messages accumulated
 * after `merge_summary_at` cross a threshold — K messages OR T characters
 * — the tail is folded back into the summary and `merge_summary_at`
 * advances so the "since" window stays small and the cached prefix stays
 * stable. Pure predicate — no I/O — kept exported for the unit test.
 */
export const MERGE_TAIL_ROLLUP_K_MESSAGES = 20;
export const MERGE_TAIL_ROLLUP_T_CHARS = 8000;
export function shouldRollupTail(tailMessageCount: number, tailCharCount: number): boolean {
  return tailMessageCount >= MERGE_TAIL_ROLLUP_K_MESSAGES
    || tailCharCount >= MERGE_TAIL_ROLLUP_T_CHARS;
}

/**
 * Hard cap on the raw-message window fed to the model per turn (Phase 3
 * of ticket-merge-summary-and-context-cap). N > K by design, so under
 * normal operation the rollup fires first and the cap never bites. The
 * cap is a safety belt for edge cases: rollup fell behind because of a
 * Sonnet outage, or a burst of customer messages arrived after the
 * rollup triggered but before it landed. Beyond N, the merge_summary
 * carries prior state — no information is lost from the model's view.
 *
 * Kept slightly above K so a normal K-triggered rollup on a bursty
 * ticket leaves headroom before the cap kicks in and truncates.
 */
export const HARD_CONTEXT_CAP_N_MESSAGES = 25;
export function applyRawWindowCap<T>(
  messages: T[],
  cap: number = HARD_CONTEXT_CAP_N_MESSAGES,
): { tail: T[]; truncatedCount: number } {
  if (messages.length <= cap) return { tail: messages, truncatedCount: 0 };
  // Keep the NEWEST N (drop the oldest). The merge_summary carries the
  // dropped-from-view state; the newest messages are what the model needs
  // to reason about the current turn.
  return {
    tail: messages.slice(messages.length - cap),
    truncatedCount: messages.length - cap,
  };
}

/**
 * Render the per-ticket merge-summary cache prefix — the block that
 * downstream Opus turns read INSTEAD of re-deriving state from the full
 * merged history. Pure — used by buildPreContext to construct the
 * cache-controlled content block on the user turn.
 */
export function renderMergeSummaryPrefix(summary: string, summaryAt: string): string {
  return `MERGE SUMMARY (locked in at ${summaryAt} — the durable state of this ticket as of that time; downstream turns read this instead of re-deriving state from the full merged history).

${summary}

Everything below is the conversation SINCE that lock-in — the tail. Rely on this summary for prior state; only the tail changes turn-to-turn.`;
}

/**
 * Phase 1 of docs/brain/specs/orchestrator-surfaces-line-item-variant-and-computed-per-unit-price.md.
 *
 * Compute the actual charged total per order line and its rounded
 * per-unit price so the orchestrator never has to multiply MSRP-ish
 * fields to infer what the customer really paid.
 *
 * Preference order per line:
 *   1. `line_total_cents` / `total_cents` when the row already carries it
 *      (internal + amplifier orders stamp both).
 *   2. Pro-rata attribution from the order's chargeable subtotal —
 *      `payment_details.subtotal_cents` when present, else
 *      `orders.total_cents` — split by each line's (price_cents × qty)
 *      weight so a multi-line order does not collapse everything onto
 *      one line.
 *   3. Fall back to `price_cents × qty` when nothing else is available.
 */
export type OrchestratorOrderLineForCompute = {
  quantity?: number | null;
  price_cents?: number | null;
  total_cents?: number | null;
  line_total_cents?: number | null;
};

/**
 * Phase 2 of docs/brain/specs/orchestrator-surfaces-line-item-variant-and-
 * computed-per-unit-price.md — resolve the customer-facing variant/flavor
 * for one order line item.
 *
 * Preference order:
 *   1. `variant_title` stamped on the row (internal/amplifier orders).
 *   2. `products.variants[].title` resolved via `variant_id` from a
 *      pre-loaded map (Shopify-synced rows carry variant_id only — the
 *      pre-fix render fell through to no variant at all here, forcing
 *      Sonnet to infer 'Berry' from the product title).
 *   3. `null` — nothing to surface; the render should omit the variant
 *      parenthetical rather than emit an empty one.
 */
export function resolveLineVariantTitle(
  line: { variant_title?: string | null; variant_id?: string | null },
  variantTitleMap: Map<string, string>,
): string | null {
  const stamped = (line.variant_title || "").trim();
  if (stamped) return stamped;
  const vid = line.variant_id ? String(line.variant_id) : "";
  const resolved = vid ? (variantTitleMap.get(vid) || "").trim() : "";
  return resolved || null;
}
export function computeChargedLineTotals(
  order: {
    total_cents?: number | null;
    payment_details?: { subtotal_cents?: number | null } | null | unknown;
  },
  lines: OrchestratorOrderLineForCompute[],
): Array<{ chargedTotalCents: number; perUnitCents: number }> {
  const pd = (order.payment_details as { subtotal_cents?: number | null } | null) || null;
  const orderCharged = (pd?.subtotal_cents ?? order.total_cents ?? 0) || 0;
  const weights = lines.map(l => Math.max(0, (l.price_cents || 0) * (l.quantity || 0)));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  return lines.map((l, idx) => {
    const qty = Math.max(1, l.quantity || 1);
    const stored = l.line_total_cents ?? l.total_cents ?? null;
    let chargedTotal: number;
    if (stored != null) {
      chargedTotal = stored;
    } else if (totalWeight > 0 && orderCharged > 0) {
      chargedTotal = Math.round(orderCharged * (weights[idx] / totalWeight));
    } else {
      chargedTotal = (l.price_cents || 0) * qty;
    }
    return {
      chargedTotalCents: chargedTotal,
      perUnitCents: Math.round(chargedTotal / qty),
    };
  });
}

async function buildPreContext(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  message: string,
  channel: string,
  personality?: { name?: string; tone?: string; sign_off?: string | null } | null,
  agentContext?: { assigned: boolean; intervened: boolean } | null,
  // Phase 5 Fix 1 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md.
  // When a live Direction is passed (superseded_at NULL), the user block is built
  // from the Direction's intent + context_summary + guardrails INSTEAD of the
  // customer-name/orders/full-history block. Sol summarized the ticket at
  // first-touch so re-fetching wastes tokens on data the model would re-summarize
  // identically. The shared system prefix stays byte-identical (cache-friendly);
  // only the volatile user block changes shape. See docs/brain/inngest/unified-ticket-handler.md
  // § Step 2e (Direction-scoped branch).
  directionOverride?: TicketDirection | null,
): Promise<{ system: string; userBlockPrefix: string | null; userBlock: string }> {
  const admin = createAdminClient();

  const [
    { data: workspace },
    { data: customer },
    { data: ticket },
    { data: messages },
    { data: guidanceNotes },
    { data: journeys },
    { data: playbooks },
    { data: workflows },
    { data: dbPrompts },
    { data: policies },
    compiledLibrarySection,
  ] = await Promise.all([
    admin.from("workspaces").select("name").eq("id", workspaceId).single(),
    customerId
      ? admin.from("customers").select("first_name, last_name, email").eq("id", customerId).single()
      : Promise.resolve({ data: null }),
    admin.from("tickets").select("tags, active_playbook_id, page_context, subject, detected_language, merge_summary, merge_summary_at").eq("id", ticketId).single(),
    admin.from("ticket_messages")
      .select("direction, body_clean, body, visibility, author_type, is_ai_guidance, created_at")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: false })
      .limit(12),
    // Agent-pinned AI guidance notes. Fetched separately so they're
    // always included even if they fall outside the 12-message window
    // (a long thread can push guidance out of context otherwise).
    admin.from("ticket_messages")
      .select("body, body_clean, created_at, author_id")
      .eq("ticket_id", ticketId)
      .eq("is_ai_guidance", true)
      .order("created_at", { ascending: true }),
    admin.from("journey_definitions")
      .select("name, trigger_intent, description")
      .eq("workspace_id", workspaceId).eq("is_active", true).order("name"),
    admin.from("playbooks")
      .select("name, trigger_intents, description")
      .eq("workspace_id", workspaceId).eq("is_active", true).order("name"),
    admin.from("workflows")
      .select("name, template, trigger_tag")
      .eq("workspace_id", workspaceId).eq("enabled", true).order("name"),
    admin.from("sonnet_prompts")
      .select("category, title, content")
      .eq("workspace_id", workspaceId).eq("enabled", true)
      .eq("status", "approved")  // never load proposed/rejected prompts
      .order("category").order("sort_order"),
    // Active policies — single source of truth for returns / refunds /
    // subscriptions / exchanges / crisis. Replaces ~60 scattered prompts
    // that previously paraphrased the same rules and drifted over time
    // (the same-day-void incident on 2026-05-26 was a contradiction
    // between two prompts that lived in different rule-bodies).
    admin.from("policies")
      .select("slug, name, internal_summary")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .is("superseded_by", null)
      .order("slug"),
    // Phase 3 of playbook-compiler-becomes-box-agent-mining-full-history —
    // Sol's first-touch direction-setting session reads the COMPILED LIBRARY
    // (approved compiler-derived playbooks + persisted trees) as a durable,
    // DB-driven input alongside the built-in catalog. Best-effort by
    // construction (the reader swallows errors → empty string on hiccup);
    // per-workspace, so it sits INSIDE the stable system prompt without
    // invalidating the shared prefix. See [[../libraries/playbook-compiler]]
    // `loadCompiledLibraryPromptSection`.
    (async () => {
      try {
        const { loadCompiledLibraryPromptSection } = await import("@/lib/playbook-compiler");
        return await loadCompiledLibraryPromptSection(admin, workspaceId, { treesLimit: 10 });
      } catch {
        return "";
      }
    })(),
  ]);

  const wsName = workspace?.name || "our store";
  const cName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || "Customer";
  const cEmail = customer?.email || "unknown";
  const tags = ((ticket?.tags as string[]) || []).join(", ") || "none";
  // Customers often put the actual topic in the subject and only short
  // context in the body ("is there caffeine in amazing creamer" / body:
  // "I can't tolerate caffeine"). Surface the subject explicitly so
  // Sonnet doesn't miss product names mentioned only there.
  const ticketSubject = (ticket?.subject as string | null) || "";
  const activePlaybookId = ticket?.active_playbook_id || null;

  // ── Phase 2: durable merge summary as a stable per-ticket cache prefix ──
  // When a ticket has a merge_summary, we no longer feed the last-12 slice of
  // the full merged history to the model — we feed the frozen summary block
  // (as a cache-controlled prefix on the user turn — see api-call
  // construction ~line 1730) plus ONLY the tail: messages created after
  // merge_summary_at. This kills the cache-recost failure mode measured on
  // ticket 49ddd6c4 ($8.92 via ai-usage.ts usageCostCents, where
  // cache-creation was billed at 1.25x input on the re-sent history every
  // turn) — the summary is now a cache_read after the first turn.
  const mergeSummary = (ticket as { merge_summary?: string | null } | null)?.merge_summary || null;
  const mergeSummaryAt = (ticket as { merge_summary_at?: string | null } | null)?.merge_summary_at || null;
  type SinceMsg = {
    direction: string;
    body_clean?: string;
    body?: string;
    visibility: string;
    author_type: string;
    is_ai_guidance?: boolean;
    created_at: string;
  };
  let sinceMessages: SinceMsg[] | null = null;
  if (mergeSummary && mergeSummaryAt) {
    const { data: since } = await admin.from("ticket_messages")
      .select("direction, body_clean, body, visibility, author_type, is_ai_guidance, created_at")
      .eq("ticket_id", ticketId)
      .gt("created_at", mergeSummaryAt)
      .order("created_at", { ascending: true })
      // Safety cap. The rollup threshold (K messages / T chars) fires the
      // tail back into the summary long before this — this ceiling only
      // matters if the rollup fell behind on a burst.
      .limit(60);
    sinceMessages = (since || []) as SinceMsg[];

    // Fire-and-forget tail rollup. When the accumulated tail crosses K
    // messages or T chars, kick off a Sonnet call to fold the tail into
    // the summary and advance merge_summary_at. The CURRENT turn still
    // sends the tail (bounded by the fetch cap above); the NEXT turn
    // reads the fresh summary + a small tail. Awaiting here would add
    // Sonnet-call latency to every threshold-crossing turn — void the
    // promise instead.
    const tailChars = sinceMessages.reduce(
      (n, m) => n + ((m.body_clean || m.body || "").length),
      0,
    );
    if (shouldRollupTail(sinceMessages.length, tailChars)) {
      void rollupMergeSummaryTail(admin, workspaceId, ticketId, mergeSummary, sinceMessages).catch((err) => {
        console.warn("[sonnet-orchestrator] merge-summary tail rollup failed (non-fatal):", err);
      });
    }
  }

  // If active playbook, get its name
  let activePlaybookNote = "";
  if (activePlaybookId) {
    const { data: pb } = await admin.from("playbooks").select("name").eq("id", activePlaybookId).single();
    activePlaybookNote = `\nACTIVE PLAYBOOK: "${pb?.name || "Unknown"}" is in progress on this ticket. If the customer's message is responding to the playbook's question, route to playbook. If they're asking about something else (conversation drift), answer their question instead.`;
  }

  // Conversation history — external messages + action completion notes.
  // When merge_summary is set, we render the SINCE-window (ascending) that
  // was fetched above; the summary carries prior state. Otherwise we render
  // the latest-12 slice (fetched desc → reverse to ascending).
  let convoBlock = "";
  const rawConvoSource: SinceMsg[] | null = sinceMessages
    ? sinceMessages
    : (messages ? [...messages].reverse() as SinceMsg[] : null);
  // ── Phase 3: hard context cap ──
  // Applied AFTER the rollup fire-and-forget above and BEFORE render, so
  // even a bursty merged ticket whose rollup fell behind still sends a
  // bounded raw-message window. Non-merged tickets fetch limit:12 upstream
  // and can never exceed N=25 — the cap is de-facto a merged-ticket
  // safeguard. `applyRawWindowCap` is a pure slice; the merge_summary in
  // userBlockPrefix preserves the dropped state so nothing is lost from
  // the model's view (see docs/brain/specs/ticket-merge-summary-and-context-cap.md
  // Phase 3 verification).
  const capped = rawConvoSource
    ? applyRawWindowCap(rawConvoSource, HARD_CONTEXT_CAP_N_MESSAGES)
    : { tail: null as SinceMsg[] | null, truncatedCount: 0 };
  if (capped.truncatedCount > 0) {
    // Structured log so the cap is never silent — picked up by the Vercel
    // log drain and surfaced on the [[ai-usage]] cost-audit pass. Not a
    // sysNote (would clutter every capped turn); one log line per turn
    // makes the truncation observable without noise on the ticket itself.
    console.info(JSON.stringify({
      event: "orchestrator_raw_window_capped",
      ticketId,
      workspaceId,
      cap: HARD_CONTEXT_CAP_N_MESSAGES,
      raw_count: rawConvoSource?.length ?? 0,
      truncated: capped.truncatedCount,
      relied_on_summary: Boolean(mergeSummary),
    }));
  }
  const convoSource: SinceMsg[] | null = capped.tail;
  if (convoSource?.length) {
    const ordered = convoSource;
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
      // 200 chars was too aggressive — it cut Myranda McConnell's
      // legal-claim message at "We are in need of" and Sonnet then
      // escalated as "message appears incomplete" (ticket 2025d4c6).
      // 2000 chars covers >99% of customer messages including
      // forwarded legal/business inquiries while keeping the
      // conversation block under ~6k tokens at the 12-message limit.
      .map((m: { direction: string; author_type: string; body_clean?: string; body?: string }) => {
        const text = (m.body_clean || m.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
        const who = m.direction === "inbound" ? "Customer"
          : m.author_type === "system" ? "[Action]"
          : "Agent";
        return `${who}: ${text}`;
      })
      .join("\n");
  }

  // Agent-pinned AI guidance — chronological. Rendered as a separate
  // top-level block so Sonnet treats them as binding rules for THIS
  // ticket, not just chat history. Agents use these to encode policy
  // calls the AI can't infer (e.g. "stand firm — do not escalate even
  // if customer repeats").
  let guidanceBlock = "";
  if (Array.isArray(guidanceNotes) && guidanceNotes.length > 0) {
    guidanceBlock = guidanceNotes
      .map((g: { body?: string; body_clean?: string }) =>
        `- ${((g.body_clean || g.body || "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000))}`,
      )
      .filter((s) => s.length > 2)
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

  const detectedLang = (ticket as { detected_language?: string | null } | null)?.detected_language || "en";
  const langDirective = detectedLang !== "en"
    ? `\nCUSTOMER LANGUAGE: ${detectedLang}. The customer writes in this language. When you generate any response_message, write it directly in ${detectedLang} — do not draft in English. Canned playbook/macro text is auto-translated downstream; only your own writing needs to be in-language.`
    : "";

  const pageContextNote = (() => {
    const pc = ticket?.page_context as { product_title?: string; product_handle?: string; page_path?: string } | null;
    if (!pc) return "";
    const parts: string[] = [];
    if (pc.product_title) parts.push(`viewing the ${pc.product_title} product page`);
    else if (pc.product_handle) parts.push(`viewing /products/${pc.product_handle}`);
    else if (pc.page_path) parts.push(`viewing ${pc.page_path}`);
    return parts.length
      ? `\nPAGE CONTEXT: Customer started this chat while ${parts.join(", ")}. If their question is product-related, prioritize that product in your answer.`
      : "";
  })();

  // ── AGENT CONTEXT: informational only ──
  // Phase 3 of docs/brain/specs/human-directives-hard-gates-over-ticket-ai.md
  // RETIRED the "respond but hold, take no actions / an agent will be back
  // shortly" half-mode that used to sit here. That half-mode was the
  // empty-reassurance loop the spec calls out: it emitted an
  // acknowledge-and-defer reply on every follow-up, produced no real
  // resolution, and doubled as a de-facto off-switch for the AI on any
  // human-touched ticket. The REAL off-switches are now ai_disabled
  // (Phase 1, full handler skip) and analyzer_locked (Phase 2, cron
  // veto). If a human wants the AI off on THIS ticket, they set
  // ai_disabled — the handler never reaches this file. If they want the
  // analyzer to leave it alone, they set analyzer_locked. Absent those,
  // a ticket is fully AI-handled — playbooks run, actions execute,
  // positive closes are honored — regardless of agent_intervened. The
  // agentContext argument is kept for API compatibility with existing
  // callers (unified-ticket-handler + tests) but no longer inserts a
  // behavior-limiting directive into the prompt.
  void agentContext;
  const agentContextNote = "";

  // ── STABLE system prompt — byte-identical for every ticket in the
  // workspace (modulo channel/personality). It carries the heavy, shared
  // payload: handlers, personality, policies, rules, output schema. The
  // orchestrator marks this with a 1-hour cache breakpoint, so it's written
  // once per hour and read at 0.1x on every subsequent ticket / turn /
  // tool-use round. CRITICAL: keep this free of per-ticket, per-turn, or
  // per-call content — prompt caching is a prefix match, so anything
  // volatile here invalidates the shared prefix for everyone. (That was the
  // pre-2026-06 leak: the whole prompt was one block with the customer +
  // conversation ahead of the rules, so cache_creation ≈ cache_read and the
  // ~60K stable payload was re-billed at full price on every ticket.)
  const system = `You are a customer support agent for ${wsName}. Analyze the customer's message and decide the best action.

You have tools to look up data. Use them to gather what you need before making your decision.

AVAILABLE HANDLERS (interactive flows you can route customers to — you select them, the system builds the form):
Journeys (on chat: embedded form, on email: CTA button to mini-site):
${journeyLines}
Playbooks (multi-step guided flows with policies):
${playbookLines}
Workflows (automated tasks):
${workflowLines}

PERSONALITY:
${persBlock}

${buildPoliciesSection(policies || [])}

${buildPromptSections(dbPrompts || [])}

${compiledLibrarySection ? `${compiledLibrarySection}\n\n` : ""}DISCOUNT-CLAIM VERIFICATION (hard rule — never agree-and-refund a discount claim):
When a customer claims they did NOT get a discount / promo / coupon, or that a discount "didn't apply," NEVER agree or compute a refund from their claim. Verify against the order data first:
- The order's actual applied discount is in its "coupons" field (code + dollar amount) in RECENT ORDERS. If the order already shows a coupon and amount, the discount WAS applied — show the customer the code + the amount, do not refund it again.
- Quantity-break discounts depend on the cart's total unit count (the storefront tiers are e.g. 0% / 8% / 12% for 1 / 2 / 3 units). A 1-unit order does NOT earn a multi-unit break — never invent a discount the cart never qualified for.
- The subscribe-&-save percentage applies ONLY to subscription orders, not one-time purchases.
- The WELCOME code is the one-time signup offer (auto-applied at checkout); it is not stackable with a second percentage.
Confirm (a) what was actually applied on the order and (b) what the customer was actually eligible for, then answer from that. Only after both check out does any adjustment get considered. Never refund a discount the order already shows, and never grant one the cart never qualified for. If the math is genuinely ambiguous, escalate rather than guess.

SUBSCRIPTION OVERCHARGE (hard rule — check BEFORE create_return / cancel on any billing complaint):
On ANY subscription cancel / refund / "wrong price" / "charged too much" ticket, first CHECK the account context for an "OVERCHARGE DETECTED" block before reaching for create_return or cancel. An overcharge is a renewal that charged materially above the customer's grandfathered/established rate (a silent price creep, or a dropped grandfathered base now billing at/above MSRP). When the context shows OVERCHARGE DETECTED, the fix is NOT a cancel or a return — it's:
1. partial_refund of the delta (charged − expected) on the overcharging order (shopify_order_id from the block).
2. update_line_item_price to restore the grandfathered base going forward — pass the base_price_cents from the block. This heals the sub in place (Appstle pricing-policy heal for Appstle subs; price_override_cents for internal subs). NEVER migrate-to-internal as the fix — a pricing error is healed on Appstle, not migrated (migration needs a saved Braintree payment method and is not for this).
3. A customer_reply: we caught the pricing error, refunded the difference, fixed the subscription so future renewals are correct, and there's no need to cancel.
Run all three in one direct_action turn. If the context shows NO overcharge, do not invent one — follow the PRICE COMPARISON RULE (a renewal matching prior renewals, or a below-floor price raised to the 50% floor, is NOT an overcharge).

RETIRED ACTION (hard rule — do NOT emit): The direct-action type "skip_next_order" has been RETIRED. It ran against a dead upstream endpoint and failed ~88% of the time. Never include an action with type "skip_next_order" in your response. Route the intent by what the customer actually wants:
- The customer wants their next box LATER ("push it to next month", "skip the next one", "not ready yet", "delay") → emit direct_action with type "change_next_date" and a date roughly one billing cycle out (the next-next-scheduled-date).
- The customer wants their next box NOW ("send today", "asap", "ship it now", "I'm out") → emit direct_action with type "bill_now" (equivalent: "order_now" — both names route to the same subscriptionOrderNow charge; the customer-facing / portal name is "order_now").
- If neither reading fits, escalate rather than emit skip_next_order.

ORDER-NOW / BILL-NOW IS ALWAYS REACHABLE (hard rule — never claim non-existence): Order-now (a.k.a. bill_now) is a real, always-available direct-action for ANY active subscription — it fires subscriptionOrderNow / orderNowByContract to charge the current upcoming order immediately. It is NOT emergency-only, NOT crisis-only, NOT limited to a subset of customers. If you offered to ship a customer's order sooner and then reason yourself out of it ("no bill_now action exists", "that action is only for emergencies", "we can't do that from here"), STOP — that is a hallucination, not a policy. Either emit the direct_action (with contract_id) — the selective-clarify gate will insert a confirm-first turn when confidence is low — or, if a real policy blocks it (e.g. the customer has no active sub, the sub is paused/cancelled, dunning is in flight), state the concrete blocker and offer the in-policy alternative. Never renege on an offer by inventing a nonexistent capability limit. (Ticket 0a9e4d7f, Judy — Sol offered, then reneged: "no bill_now action exists for non-emergency requests" — the failure this rule retires.)

CLARIFICATION TURNS (hard rule — a clarification is a COMPLETE message, not a bare question):
When you set needs_clarification=true, your response_message is what the customer actually receives — it is NOT a placeholder or a stub, and clarification_question is NEVER what gets sent. Write response_message as a complete customer-facing message under the [[docs/brain/customer-voice.md]] rules (short paragraphs, max 2 sentences each, plain text, no markdown, no re-greeting on follow-ups), in this shape:
1. ACKNOWLEDGE the request in the customer's own framing so they know you understood what they asked.
2. Say what you CAN and CAN'T do and WHY — cite the relevant policy briefly (e.g. "your order already shipped so it's locked in", "the pause window closed at renewal", "the loyalty tier caps this at $25").
3. Set EXPECTATIONS for the path you're proposing (e.g. "your next renewal on Aug 2", "we'd need to wait until the return arrives", "the code applies to your next order").
4. THEN ask the single question you need to move forward. One question, not several.
Worked example (ticket 71538c70 — customer wrote "swap creamer for coffee" on a just-shipped order with an active sub, choices are Cocoa or Hazelnut). BAD (bare question, strips your reasoning): "Cocoa or Hazelnut?" GOOD (contextualized): "Your order shipped yesterday so I can't change that one, but I can update your subscription so your next delivery on Aug 2 has the swap — would you like Cocoa or Hazelnut?" The GOOD version acknowledges the swap request, states the shipped order can't be changed and points at the next renewal instead, and only then asks the one question. Use this shape on every clarification turn.
clarification_question is internal metadata only — the system keeps it for turn tracking and evals but does not send it. If after your tools you already have the full answer, do NOT force a clarifying question; respond directly (needs_clarification=false) with the resolution.

When you have enough data, respond with ONLY valid JSON (no tool calls):
{
  "reasoning": "brief explanation",
  "action_type": "direct_action" | "journey" | "playbook" | "workflow" | "macro" | "kb_response" | "ai_response" | "escalate",
  "actions": [{ "type": "...", "contract_id": "...", ... }],
  "handler_name": "name of journey/playbook/workflow if applicable",
  "response_message": "message to send customer — REQUIRED whenever you're speaking to them, including every clarification turn. On a clarification turn, this is the complete message per the CLARIFICATION TURNS rule above (acknowledge → what you can/can't do and why → expectations → the one question), NOT a bare question",
  "needs_clarification": false,
  "clarification_question": null,
  "problem": "one-line diagnosis of the customer's underlying problem (what they actually need resolved, not the surface ask)",
  "confidence": 0.0-1.0,
  "options": [{ "label": "short name of an option you considered", "action_shape": {"type": "...", "...": "..."}, "expected_effect": "what the customer sees if we pick this" }],
  "chosen": { "option_index": 0, "why": "one sentence — why this option beats the others for THIS customer" }
}

RESOLUTION-RECORD FIELDS (problem / confidence / options / chosen) — a per-turn ledger of your reasoning:
- problem: your one-line diagnosis of the underlying problem, in your words (not the customer's phrasing).
- confidence: 0.0-1.0 how sure you are the chosen action solves it. Below 0.6 → prefer a clarifying turn (needs_clarification=true) over acting — your response_message on that turn still ships as a COMPLETE customer message per the CLARIFICATION TURNS rule above (acknowledge → what you can/can't do and why → expectations → the one question), never as a bare question.
- options: 1-4 options you SERIOUSLY considered before picking. Each carries the action_shape it would fire and the expected_effect on the customer.
- chosen: option_index into options[] plus a one-sentence why. If options is a single row, chosen.option_index is 0.
These do NOT change what you execute — action_type + actions + response_message are still the authoritative plan. The four fields let downstream verification catch responses that don't actually address the diagnosed problem, and let calibration mine your reasoning over time. Always include them on a real decision.
Note: "type" on any actions[] entry must NEVER be "skip_next_order" (retired — see above).`;

  // ── PER-TICKET STABLE PREFIX — the durable merge_summary block. Marked
  // with cache_control by the caller so it's written on the first turn after
  // a merge and read at 10% of input on every subsequent turn (up to the
  // next tail-rollup). This is the whole point of Phase 2 — the ~$8.92 recost
  // measured on ticket 49ddd6c4 was the full merged history being re-sent as
  // uncached input on every Opus turn; the summary block sits in front of
  // the volatile tail and stops that recost loop. See ai-usage.ts
  // usageCostCents cache accounting.
  const userBlockPrefix = mergeSummary && mergeSummaryAt
    ? renderMergeSummaryPrefix(mergeSummary, mergeSummaryAt)
    : null;

  // ── VOLATILE per-ticket / per-turn content — NOT cached (it changes every
  // turn as the conversation grows). currentDateContext() lives here too so
  // the daily date rollover never invalidates the shared system prefix.
  const convoHeader = mergeSummary && mergeSummaryAt
    ? `CONVERSATION SINCE MERGE SUMMARY (locked ${mergeSummaryAt}):`
    : "CONVERSATION:";
  const userBlock = `${currentDateContext()}

CUSTOMER: ${cName} (${cEmail})${langDirective}
TICKET SUBJECT: ${ticketSubject || "(none)"}
TICKET TAGS: ${tags}${activePlaybookNote}${pageContextNote}${agentContextNote}

${guidanceBlock ? `AGENT GUIDANCE (binding for this ticket — written by a human agent who knows context the system doesn't. Follow these even if they conflict with default reasoning):
${guidanceBlock}

` : ""}${convoHeader}
${convoBlock || `Customer: ${message.slice(0, 300)}`}`;

  // Phase 5 Fix 1 Direction-scoped user block. When a non-superseded live Direction
  // is passed, the caller has already committed to Sol's summary as the durable
  // per-turn state — the customer-name / orders / full-history block above becomes
  // dead cost. Swap the userBlock (only) with the Direction's rendered suffix +
  // just the newest inbound message. Keep the shared system prefix + userBlockPrefix
  // untouched so the 1-hour cache breakpoint still hits. On chosen_path='playbook'
  // WITHOUT an active_playbook_id (the Phase 4 short-circuit fall-through), the
  // playbook step is omitted deliberately — assembleDirectionContext returns
  // playbook_snapshot=null in that case, and this branch mirrors that.
  if (directionOverride && !directionOverride.superseded_at) {
    const directionSuffix = renderDirectionSystemPrompt(directionOverride, null);
    const directionUserBlock = `${currentDateContext()}

${directionSuffix}${guidanceBlock ? `

AGENT GUIDANCE (binding for this ticket — written by a human agent who knows context the system doesn't. Follow these even if they conflict with default reasoning):
${guidanceBlock}` : ""}

NEWEST INBOUND (Sol's Direction above summarizes everything prior — do NOT re-fetch customer / orders / prior history):
Customer: ${message.slice(0, 2000)}`;
    return { system, userBlockPrefix: null, userBlock: directionUserBlock };
  }

  return { system, userBlockPrefix, userBlock };
}

/**
 * Fold the accumulated "since window" tail back into the ticket's
 * merge_summary and advance merge_summary_at so the next turn's cache
 * prefix stays small and stable. Called fire-and-forget from
 * buildPreContext when shouldRollupTail() fires. Never throws — a rollup
 * failure just means the next turn keeps sending the current (still
 * bounded) tail; no customer-facing behavior degrades.
 *
 * Reuses buildMergeSummaryPrompt from ticket-merge so the summarizer shape
 * (prior state + newly-arrived messages → updated summary) is the same in
 * both the merge-time write and the tail-rollup path.
 */
async function rollupMergeSummaryTail(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
  priorSummary: string,
  tail: Array<{ direction: string; body_clean?: string; body?: string; visibility: string; author_type: string; created_at: string }>,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || tail.length === 0) return;

  const { buildMergeSummaryPrompt } = await import("@/lib/ticket-merge");
  const prompt = buildMergeSummaryPrompt(
    priorSummary,
    tail.map((m) => ({
      direction: m.direction,
      author_type: m.author_type,
      visibility: m.visibility,
      body: m.body_clean || m.body || "",
      created_at: m.created_at,
    })),
  );

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        max_tokens: 800,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
    });
  } catch (err) {
    console.warn("[sonnet-orchestrator] merge-summary rollup Sonnet fetch failed:", err);
    return;
  }
  if (!res.ok) {
    console.warn("[sonnet-orchestrator] merge-summary rollup HTTP", res.status);
    return;
  }
  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: ClaudeUsage;
  };
  const updatedSummary = (data.content?.[0]?.text || "").trim();
  if (!updatedSummary) return;

  // Advance merge_summary_at to the LATEST tail message's created_at so the
  // next "since window" query starts after everything we just folded in.
  // Guarded update: eq(id, workspace_id) + select("id") so we assert exactly
  // one row transitioned and can't scribble across another workspace.
  const latestTailAt = tail[tail.length - 1]?.created_at || new Date().toISOString();
  const { data: written } = await admin
    .from("tickets")
    .update({
      merge_summary: updatedSummary,
      merge_summary_at: latestTailAt,
    })
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .select("id");
  if (!written || written.length !== 1) {
    console.warn("[sonnet-orchestrator] merge-summary rollup update matched", written?.length ?? 0, "rows");
    return;
  }

  void logAiUsage({
    workspaceId,
    model: SONNET_MODEL,
    usage: data.usage,
    purpose: "merge_summary_tail_rollup",
    ticketId,
  });
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
      case "get_customer_timeline": {
        const t = await buildCustomerTimeline(workspaceId, customerId);
        return timelineToText(t);
      }
      case "get_product_knowledge":
        return await getProductKnowledge(admin, workspaceId, (input?.query as string) || "");
      case "get_product_nutrition":
        return await getProductNutrition(admin, workspaceId, (input?.query as string) || "");
      case "check_inventory":
        return await checkInventory(admin, workspaceId, (input?.query as string) || "");
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
      case "get_payment_methods":
        return await getPaymentMethods(admin, workspaceId, customerId);
      case "get_order_refund_ledger":
        return await getOrderRefundLedgerTool(admin, workspaceId, customerId, String(input?.order_number || ""));
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error fetching data: ${errText(err)}`;
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
    { data: profile },
  ] = await Promise.all([
    admin.from("subscriptions")
      .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, created_at")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .in("status", ["active", "paused", "cancelled"])
      .order("created_at", { ascending: false }),
    // Order history so Sonnet has full visibility — old 5-order cap
    // missed customers' relevant history. Surfaced on ticket 6e732303
    // (Veronica) where the playbook kept saying "no orders found" while
    // the customer was citing 25-and-53-day-old order numbers. We also
    // include subscription_id so each order can be labeled with which sub
    // it belongs to (or "one-time" if null).
    //
    // We fetch the 25 most recent orders with NO date floor here and apply
    // the "last 180 days OR at least the 3 most recent" window in code
    // below. A hard .gte(180d) floor hid the fact that a disputed charge
    // was a RENEWAL (an older first order sits outside 180d) — ticket
    // 125741eb (marty), where Sol saw only the renewal and could read it
    // as a first order. Always surfacing the last ≥3 restores the
    // renewal-vs-first-order signal without unbounding old accounts.
    admin.from("orders")
      .select("order_number, total_cents, line_items, discount_codes, payment_details, created_at, financial_status, shopify_order_id, fulfillments, source_name, subscription_id")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .order("created_at", { ascending: false }).limit(25),
    // Loyalty record may live on ANY of the linked customer profiles.
    // Bug we fixed: previously this used .eq("customer_id", custId)
    // and missed records belonging to a sibling profile (e.g. ticket
    // from tbaxtel@hotmail.com but loyalty on tbaxtel@me.com).
    admin.from("loyalty_members")
      .select("id, points_balance")
      .eq("workspace_id", wsId)
      .in("customer_id", allCustIds)
      .order("points_balance", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Marketing consent — surface so AI knows whether to fire
    // unsubscribe_email_marketing / unsubscribe_sms_marketing actions
    // when the customer asks to be removed from lists. Pulled on the
    // primary customer only (not linked profiles — consent is per-row
    // and Shopify mutations require the specific customer's identity).
    admin.from("customers")
      .select("email_marketing_status, sms_marketing_status, shopify_customer_id")
      .eq("id", custId)
      .maybeSingle(),
  ]);

  const parts: string[] = [];

  // Window the order history: the last 180 days, but ALWAYS at least the 3
  // most recent orders if they exist (so a disputed renewal never hides the
  // older first order — the renewal-vs-first-order signal). `orders` arrives
  // sorted created_at DESC, so the within-180d rows are a prefix; we show
  // max(count-within-180d, 3) from the front.
  const ORDER_WINDOW_MS = 180 * 86400000;
  const orderCutoffIso = new Date(Date.now() - ORDER_WINDOW_MS).toISOString();
  const allOrders = orders || [];
  const within180Count = allOrders.filter(o => (o.created_at as string) >= orderCutoffIso).length;
  const shownOrderCount = Math.max(within180Count, 3);
  const shownOrders = allOrders.slice(0, shownOrderCount);
  const showingOlderThan180 = shownOrders.length > within180Count;

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
      const items = (s.items as { title?: string; variant_title?: string; quantity?: number; variant_id?: string; price_cents?: number | null; price_override_cents?: number | null }[] || []);
      const itemStr = items.map(i => {
        const msrp = priceMap.get(String(i.variant_id));
        // Internal-contract subs store per-line price on price_override_cents,
        // not price_cents (see resolveSubscriptionPricing in src/lib/pricing.ts:257
        // and the resubscribe flow's internal-sub creation). Fall back so the
        // SUBSCRIPTIONS block doesn't misrender them as "@ $0.00" and mislead the
        // orchestrator into skipping bill_now / undersizing save-offer + refund math.
        const realized = i.price_cents ?? i.price_override_cents ?? 0;
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
        // Always emit variant_id literally so the LLM can pass it
        // verbatim into remove_item / swap_variant / change_quantity.
        // Without this, Opus reasons from text alone and stuffs the
        // human-readable title into the action call, which fails as
        // "Variant <title> not found on contract". Single-variant
        // products like ACV Gummies still have a numeric Default
        // Title variant id — render it the same way.
        const vidTag = i.variant_id ? ` [variant_id: ${i.variant_id}]` : "";
        return `${i.title || "item"}${i.variant_title ? ` (${i.variant_title})` : ""} x${qty}${vidTag} @ $${(realized / 100).toFixed(2)} each (line $${((realized * qty) / 100).toFixed(2)})${tail.length ? ` — ${tail.join(" ")}` : ""}`;
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

  // Overcharge detection — surface the {charged, expected, delta, dropped_base}
  // signal + the remediation plan so the agent CHECKS for an overcharge before
  // reaching for create_return / cancel on a billing complaint. Read-only.
  try {
    const { detectOverchargesForCustomer, formatOverchargeForAgent } = await import("@/lib/subscription-overcharge");
    const overcharges = await detectOverchargesForCustomer(wsId, custId);
    if (overcharges.length) {
      parts.push("\n" + overcharges.map(formatOverchargeForAgent).join("\n"));
    }
  } catch (e) {
    console.error("[orchestrator] overcharge detection failed (non-fatal):", e);
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
    // Phase 2 of docs/brain/specs/orchestrator-surfaces-line-item-variant-
    // and-computed-per-unit-price.md — resolve the variant title from
    // products.variants[].title so Sonnet + the analyzer see 'Berry'
    // instead of having to infer flavor from the product title. Shopify
    // sync stamps `variant_id` on the stored line but not `variant_title`
    // (only originalUnitPriceSet), so the model was left guessing.
    const variantTitleMap = new Map<string, string>(); // variant_id → title
    if (variantIds.size > 0) {
      const { data: products } = await admin.from("products").select("variants").eq("workspace_id", wsId);
      for (const p of products || []) {
        for (const v of (p.variants as { id?: string; title?: string; price_cents?: number }[] || [])) {
          if (!v.id) continue;
          if (v.price_cents != null) msrpMap.set(String(v.id), v.price_cents);
          if (v.title) variantTitleMap.set(String(v.id), v.title);
        }
      }
    }

    // Build short labels for each subscription so per-order lines can
    // say "sub: 33237008557 (active)" instead of just a UUID. Helps
    // Sonnet reason about which sub an order belongs to when the
    // customer has multiple subs over time.
    const subLabel: Record<string, string> = {};
    for (const s of subs || []) {
      subLabel[s.id] = `${s.shopify_contract_id || s.id.slice(0, 8)} (${s.status})`;
    }

    parts.push(
      showingOlderThan180
        ? "\nRECENT ORDERS (last 180 days had fewer than 3 — showing the 3 most recent; some are older than 180 days):"
        : "\nRECENT ORDERS (last 180 days):",
    );
    for (const o of shownOrders) {
      const lineItems = (o.line_items as { title?: string; variant_title?: string; quantity?: number; price_cents?: number; total_cents?: number; line_total_cents?: number; sku?: string; variant_id?: string }[] || []);
      // Phase 1 of docs/brain/specs/orchestrator-surfaces-line-item-variant-
      // and-computed-per-unit-price.md — hand Sonnet a reconciled per-unit
      // (line total ÷ qty) so it never divides MSRP-ish price_cents by
      // hand. `charged[i]` also carries the line total for the surface
      // note. Ticket cd2e4a9a exposed the pre-fix drift: a $44.74 / 2-unit
      // order surfaced as $22.46/unit (Shopify originalUnitPriceSet, pre-
      // discount) instead of the actual $22.37/unit.
      const charged = computeChargedLineTotals(o as { total_cents?: number | null; payment_details?: { subtotal_cents?: number | null } | null }, lineItems);
      const itemStr = lineItems.map((i, idx) => {
        const qty = i.quantity || 1;
        const perUnitCents = charged[idx].perUnitCents;
        const lineTotalCents = charged[idx].chargedTotalCents;
        // Prefer a stamped variant_title (internal/amplifier orders carry
        // it) then fall back to the resolved products.variants[].title
        // for Shopify-synced lines whose row only carries variant_id.
        const resolvedVariantTitle = resolveLineVariantTitle(i, variantTitleMap);
        const titleFull = `${i.title || "?"}${resolvedVariantTitle ? ` (variant: ${resolvedVariantTitle})` : ""}`;
        const msrp = i.variant_id ? msrpMap.get(String(i.variant_id)) : undefined;
        if (msrp) {
          const standardCents = Math.round(msrp * 0.75);
          const floorCents = Math.round(msrp * 0.5);
          const flag =
            perUnitCents < floorCents ? " [BELOW 50% FLOOR — not allowed anymore]" :
            Math.abs(perUnitCents - floorCents) <= 10 ? " [AT FLOOR — minimum allowed]" :
            perUnitCents < standardCents ? " [grandfathered, above floor]" :
            "";
          return `${titleFull} x${qty} @ $${(perUnitCents / 100).toFixed(2)}/unit realized (line total $${(lineTotalCents / 100).toFixed(2)} | MSRP $${(msrp / 100).toFixed(2)} | standard sub $${(standardCents / 100).toFixed(2)} | 50% floor $${(floorCents / 100).toFixed(2)})${flag}`;
        }
        return `${titleFull} x${qty} @ $${(perUnitCents / 100).toFixed(2)}/unit realized (line total $${(lineTotalCents / 100).toFixed(2)})`;
      }).join(", ");
      const date = new Date(o.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const fulfillments = (o.fulfillments as { tracking_number?: string; status?: string }[] || []);
      const tracking = fulfillments[0]?.tracking_number ? ` | tracking: ${fulfillments[0].tracking_number}` : "";
      // Always emit the coupons field — never silently omit on empty.
      // If we leave it off, the LLM cannot tell "this order had no
      // coupon codes" from "this tool doesn't expose coupons", and
      // we've seen Opus mis-frame it as a tool limitation.
      //
      // Storefront orders carry the applied code in two places now:
      // discount_codes[] (populated at checkout going forward + by
      // backfill) and payment_details.{discount_code,discount_cents}
      // (always written). Prefer discount_codes; fall back to
      // payment_details so an un-backfilled legacy order still shows its
      // coupon. Surface the dollar amount so the AI can answer "did I get
      // my discount?" from data — the gap that caused ticket 8e9e325e.
      const pd = (o.payment_details as { discount_code?: string | null; discount_cents?: number | null } | null) || null;
      let couponsList = (o.discount_codes as string[] | null) || [];
      if (!couponsList.length && pd?.discount_code) couponsList = [pd.discount_code];
      const discountCents = pd?.discount_cents || 0;
      const amountSuffix = discountCents > 0 ? ` (-$${(discountCents / 100).toFixed(2)})` : "";
      const coupons = couponsList.length ? ` | coupons: ${couponsList.join(", ")}${amountSuffix}` : ` | coupons: none`;
      const isDraft = (o.source_name as string) === "shopify_draft_order";
      const sourceLabel = isDraft ? " [DRAFT — not a renewal, ignore for price comparisons]" : "";
      const subTag = o.subscription_id
        ? ` | sub: ${subLabel[o.subscription_id as string] || (o.subscription_id as string).slice(0, 8)}`
        : " | sub: one-time/web";
      parts.push(`- #${o.order_number} | ${date} | total $${((o.total_cents || 0) / 100).toFixed(2)} | ${o.financial_status || "?"}${sourceLabel}${subTag} | ${itemStr}${coupons}${tracking} | shopify_order_id: ${o.shopify_order_id || "?"}`);
    }
    parts.push(`PRICING TERMINOLOGY (use customer-facing language):
- "Realized price" = what the customer actually pays per unit (the per-unit price on the order). Use this when speaking to customers. Each line surfaces it computed as line total ÷ quantity, so never re-derive per-unit by multiplying anything — use the number shown.
- "Base price" = an internal-only concept (realized / 0.75). NEVER mention "base price" in customer messages.
- MSRP = the variant's listed retail price.
- Standard subscription price = MSRP × 0.75 (the default 25% subscriber discount).
- 50% MSRP floor = the absolute minimum realized price we honor. Customers historically below this floor were raised TO the floor by a cleanup; their old price can no longer be offered.

PRICE COMPARISON RULE: compare per-unit realized prices across orders, never totals. If a renewal's per-unit matches prior renewals → NOT overcharged. If the per-unit went UP from a below-floor historical price to the 50% floor, that's the cleanup raising them to our minimum — explain rather than refund. If a renewal's per-unit went up beyond the 50% floor for no reason, that's a real overcharge worth investigating.

DRAFT ORDERS: orders flagged [DRAFT — not a renewal] are manual draft orders (source: shopify_draft_order). They often show MSRP-based pricing because they're not subject to subscription contract pricing. NEVER use them to argue a customer was overcharged on their actual subscription.`);
  } else {
    parts.push("\nRECENT ORDERS: None");
  }

  // Store credit — pulled live from Shopify (customer.storeCreditAccounts).
  // Always emit so the LLM can answer "apply my store credit" requests
  // accurately and distinguish "no store credit" from "no field exposed"
  // (same pattern as the loyalty empty-state fix). Try every linked
  // profile so a credit issued to one email surfaces on a ticket from
  // another linked profile.
  try {
    const { getStoreCreditBalance } = await import("@/lib/store-credit");
    const { data: linkedShopifyIds } = await admin.from("customers")
      .select("shopify_customer_id, email")
      .in("id", allCustIds)
      .not("shopify_customer_id", "is", null);
    let totalCredit = 0;
    let currency = "USD";
    const perProfile: string[] = [];
    for (const c of linkedShopifyIds || []) {
      try {
        const r = await getStoreCreditBalance(wsId, c.shopify_customer_id as string);
        if (r.balance > 0) {
          totalCredit += r.balance;
          currency = r.currency || currency;
          perProfile.push(`${c.email || c.shopify_customer_id}: $${r.balance.toFixed(2)}`);
        }
      } catch { /* one profile failing shouldn't break the rest */ }
    }
    if (totalCredit > 0) {
      const detail = perProfile.length > 1 ? ` (across linked profiles: ${perProfile.join("; ")})` : "";
      parts.push(`\nSTORE CREDIT: $${totalCredit.toFixed(2)} ${currency}${detail}`);
    } else {
      parts.push(`\nSTORE CREDIT: $0 (no store credit balance on this customer or any linked profile)`);
    }
  } catch {
    parts.push(`\nSTORE CREDIT: lookup failed`);
  }

  // Loyalty — explicit empty state so the LLM doesn't mis-frame a
  // missing record as "the tool doesn't expose loyalty". Always emit
  // a LOYALTY line. If no loyalty_members row exists for any linked
  // profile, that means the customer has never participated in the
  // program (expected for older subs, manual orders, or accounts that
  // pre-date loyalty).
  if (!loyaltyMember) {
    parts.push(`\nLOYALTY: no record (this customer has never had a loyalty_members row across any linked profile — they've never accrued points)`);
  } else {
    parts.push(`\nLOYALTY: ${loyaltyMember.points_balance || 0} points`);

    // Show available redemption tiers so AI only offers real options
    const { data: loyaltyConfig } = await admin.from("loyalty_settings")
      .select("redemption_tiers")
      .eq("workspace_id", wsId)
      .single();
    const tiers = (loyaltyConfig?.redemption_tiers || []) as { label: string; points_cost: number; discount_value: number }[];
    if (tiers.length) {
      // ⭐ ABSOLUTE LOYALTY CEILING (spec:
      // loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates).
      // Filter the tier list surfaced to the LLM to only in-cap tiers — an
      // over-$15 tier that a workspace mis-configured must NEVER be offered.
      // The runtime cap is enforced deterministically in validateRedemption
      // (Phase 1) and in the June ceiling refusal (Phase 3); this prompt
      // filter keeps the LLM from proposing an over-cap redemption in the
      // first place. LOYALTY_REMEDY_MAX_CENTS is the source of truth — the
      // configurable top tier is NOT.
      const capCents = LOYALTY_REMEDY_MAX_CENTS;
      const capDollars = capCents / 100;
      const inCapTiers = tiers.filter(t => t.discount_value * 100 <= capCents);
      const tierList = inCapTiers.map(t => `${t.label} (${t.points_cost} pts → $${t.discount_value} off)`).join(", ");
      parts.push(`Available redemption tiers: ${tierList || "(none within $" + capDollars + " ceiling)"}`);
      parts.push("IMPORTANT: Only offer these exact tiers — never invent other amounts.");
      parts.push(`IMPORTANT — ABSOLUTE LOYALTY CEILING: $${capDollars} is the absolute maximum for any loyalty-derived benefit (single redemption, coupon, or partial refund via points). NEVER propose a loyalty cash-out, "make-whole" credit, or expiry-extension — loyalty exists to drive repeat purchases, never a large payout to a departing customer. If a customer asks to cash out unusable points, hold firm at the ceiling: offer the largest in-cap tier they can afford OR say plainly that loyalty points are not cashable. Do NOT propose to escalate the question to the founder — an over-cap loyalty ask is CATEGORICALLY out of scope.`);
      // One coupon per order. Redeeming many tiers at once just mints codes
      // the customer can never stack (only one applies per order/renewal), so
      // it's pointless — and offering "9 codes for all your points" reads as
      // absurd. When a customer asks to redeem ALL their points, do NOT offer
      // to generate multiple codes. Explain one-coupon-per-order and offer the
      // single highest IN-CAP tier they can afford, then redeem just that one.
      const affordableInCap = inCapTiers.filter(t => t.points_cost <= (loyaltyMember?.points_balance ?? 0));
      const topInCapTier = (affordableInCap.length ? affordableInCap : inCapTiers)
        .reduce((a, b) => (b.points_cost > a.points_cost ? b : a), inCapTiers[0] ?? tiers[0]);
      if (topInCapTier) {
        parts.push(`IMPORTANT: Only ONE coupon can be used per order (and one per subscription renewal). NEVER offer to redeem all of a customer's points into multiple codes — extra codes are useless. If they ask to "redeem all my points", say something like: one coupon per order, so there isn't much sense redeeming everything at once; the max single redemption inside the $${capDollars} ceiling is ${topInCapTier.points_cost} points for $${topInCapTier.discount_value} off — offer to redeem THAT one and send the code.`);
      }
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

  // Marketing consent — explicit so AI knows whether to fire an
  // unsubscribe direct action (vs. escalating). Includes the Shopify
  // customer ID flag so AI knows whether the action is even runnable
  // (no shopify_customer_id = the customer was created via lead-capture
  // or other non-Shopify path; we have nowhere to push the unsubscribe).
  if (profile) {
    const emailStatus = profile.email_marketing_status || "unknown";
    const smsStatus = profile.sms_marketing_status || "unknown";
    const noShopify = !profile.shopify_customer_id;
    // A channel only has something left to unsubscribe if it is currently
    // 'subscribed' (definitely on a list) or 'unknown' (we can't prove it's
    // off). 'not_subscribed' means nothing remains to remove on that channel.
    const stillOptedIn = (s: string) => s === "subscribed" || s === "unknown";
    const anyToRemove = stillOptedIn(emailStatus) || stillOptedIn(smsStatus);
    const emptyShell = !(subs?.length) && !(orders?.length);

    let consentHint = "";
    if (noShopify && anyToRemove) {
      // There is a real opt-in we cannot push to Shopify. Note the platform
      // limitation WITHOUT instructing the orchestrator to escalate — the
      // No-data-guard / ground-truth-wins rules should let it reply (confirm
      // we've recorded the opt-out internally) unless something else forces a
      // human. Decoupling "cannot push to Shopify" from "escalate" stops this
      // line from over-riding every deterministic + sonnet_prompt rule (the
      // bug behind ticket 3d828685, where an already-unsubscribed empty shell
      // was escalated purely on this hint).
      consentHint = " [NOTE: no shopify_customer_id — an unsubscribe recorded here cannot be pushed to Shopify or external lists by an automated action. We can still record the opt-out internally and reply; only escalate if the customer specifically needs removal from an external/third-party list we cannot reach.]";
    } else if (noShopify && !anyToRemove) {
      // Both channels are already not_subscribed and there's no Shopify push
      // target. Nothing to unsubscribe — steer toward a reply, not escalation.
      consentHint = emptyShell
        ? " [NOTE: already fully unsubscribed on every channel, and this customer has no orders and no subscriptions — there is nothing to unsubscribe and nothing to cancel on our side. Reply rather than escalate; any recurring charges the customer describes are not ours.]"
        : " [NOTE: already fully unsubscribed on every channel — there is nothing left to remove. No unsubscribe action is needed or possible; reply rather than escalate.]";
    }
    parts.push(`\nMARKETING CONSENT: email=${emailStatus}, sms=${smsStatus}${consentHint}`);
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

  // Unlinked potential matches — graded (address/phone-corroborated = high). Account linking is
  // FUNDAMENTAL to ticket handling: a HIGH-confidence unlinked sibling means this customer's real
  // subscription / order / charge may live on the OTHER account. Sol/June MUST check it before
  // concluding "no such account / no active subscription / no such charge" (ticket db8b3d66:
  // Elizabeth's active sub + disputed $236.50 order sat on an unlinked same-address sibling).
  const { findUnlinkedMatches } = await import("@/lib/account-matching");
  const unlinked = await findUnlinkedMatches(wsId, custId, admin);
  const high = unlinked.filter((m) => m.confidence === "high");
  const low = unlinked.filter((m) => m.confidence === "low");
  if (high.length) {
    parts.push(
      `\n⚠️ LIKELY SAME-PERSON UNLINKED ACCOUNT(S) — check before answering "no such account/charge", then PROPOSE LINKING: ` +
        high
          .map((m) => `${m.email} [${m.signals.join("+")}${m.previously_rejected ? "; previously dismissed — re-confirm" : ""}]`)
          .join(", "),
    );
  }
  if (low.length) {
    parts.push(`\nPOSSIBLE (low-confidence, name-only) unlinked accounts: ${low.map((m) => m.email).join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Per-variant Supplement Facts for nutrition questions. Reads
 * `product_variants.supplement_facts` (the same column the storefront panel +
 * KB mirror use), so the support AI can quote exact numbers per flavor
 * (sodium, potassium, caffeine, calories…) on a ticket. Only variants with
 * populated facts are returned — a product with no verified facts simply
 * isn't listed, and the tool says so rather than letting the AI guess.
 */
async function getProductNutrition(admin: Admin, wsId: string, query: string): Promise<string> {
  const [{ data: variants }, { data: products }] = await Promise.all([
    admin
      .from("product_variants")
      .select("product_id, title, option1, option2, position, supplement_facts")
      .eq("workspace_id", wsId)
      .not("supplement_facts", "is", null)
      .order("position", { ascending: true }),
    admin.from("products").select("id, title").eq("workspace_id", wsId).eq("status", "active"),
  ]);

  const titleById = new Map((products || []).map((p) => [p.id as string, (p.title as string) || ""]));
  let rows = variants || [];
  if (rows.length === 0) {
    return "No Supplement Facts are on file for any product yet, so I can't quote nutrition numbers. Don't guess — tell the customer we'll confirm and follow up.";
  }

  const q = query.trim().toLowerCase();
  if (q) {
    const matched = rows.filter((v) => {
      const pt = (titleById.get(v.product_id as string) || "").toLowerCase();
      const vt = `${v.title || ""} ${v.option1 || ""} ${v.option2 || ""}`.toLowerCase();
      return pt.includes(q) || vt.includes(q) || (pt.length > 0 && q.includes(pt));
    });
    // Fall back to the full list if the query matched nothing — better to show
    // everything we have than to claim we have nothing for this product.
    if (matched.length > 0) rows = matched;
  }

  const byProduct = new Map<string, typeof rows>();
  for (const v of rows) {
    const list = byProduct.get(v.product_id as string) || [];
    list.push(v);
    byProduct.set(v.product_id as string, list);
  }

  const parts: string[] = ["PER-VARIANT SUPPLEMENT FACTS:"];
  for (const [pid, list] of byProduct) {
    parts.push(`\n${titleById.get(pid) || "Product"}:`);
    for (const v of list) {
      const txt = formatSupplementFactsText(v.supplement_facts as SupplementFactsShape | null);
      if (!txt) continue;
      const label = ((v.title || v.option1 || "Default") as string).trim();
      parts.push(`  ${label}:`);
      for (const line of txt.split("\n")) parts.push(`    ${line}`);
    }
  }
  return parts.join("\n");
}

async function getProductKnowledge(admin: Admin, wsId: string, query: string): Promise<string> {
  // Always run RAG search — it finds the most relevant macros + KB from 286+ macros
  const searchQuery = query || "general product information";
  const [
    { data: products },
    { data: variantRows },
    { data: crises },
    { data: workspace },
    ragResults,
    canonicalOnHand,
  ] = await Promise.all([
    admin.from("products").select("id, title, handle, description").eq("workspace_id", wsId).eq("status", "active"),
    admin.from("product_variants")
      .select("product_id, title, option1, option2, sku, available, position, shopify_variant_id")
      .eq("workspace_id", wsId)
      .order("position"),
    // An active OOS crisis is the authoritative truth for a variant's stock —
    // inventory_quantity can lag Shopify and read positive on a SKU that's
    // really gone (ticket 9a7f9481: Mixed Berry showed qty 3746 mid-crisis,
    // so Opus told the customer it was back in stock and promised a reship
    // that could never ship). Fetch active crises and override `available`.
    admin.from("crisis_events")
      .select("affected_product_title, affected_variant_id, affected_sku, expected_restock_date")
      .eq("workspace_id", wsId).eq("status", "active"),
    admin.from("workspaces").select("shopify_primary_domain").eq("id", wsId).maybeSingle(),
    retrieveContext(wsId, searchQuery, 10),
    // Canonical, live on-hand (single source of truth) — replaces the stale, backfill-only
    // product_variants.inventory_quantity that caused incident 9a7f9481.
    getShopifyOnHandByVariant(admin, wsId),
  ]);

  // Customer-facing Shopify domain. NOT storefront_domain (that's our own
  // first-party storefront — currently behind login, not the public store)
  // and NOT shopify_domain (the .myshopify slug). Without this the AI was
  // inventing product URLs (e.g. "amazing-coffee-k-cups" when the real
  // handle was "amazing-coffee-pods") because product rows didn't surface
  // the handle OR the host.
  const storefrontHost = (workspace?.shopify_primary_domain || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const productUrl = (handle: string | null) =>
    handle && storefrontHost ? `https://${storefrontHost}/products/${handle}` : null;

  const parts: string[] = [];

  const titleById = new Map((products || []).map((p) => [p.id, p.title as string]));

  // An active crisis matches a variant by Shopify variant id
  // (crisis_events.affected_variant_id is a Shopify id, not our UUID), then
  // SKU, then product title as a fallback. Returns the matching crisis so the
  // restock date can be surfaced inline.
  const crisisForVariant = (
    productTitle: string,
    v: { shopify_variant_id?: string | null; sku?: string | null },
  ) =>
    (crises || []).find((c) =>
      (v.shopify_variant_id && c.affected_variant_id && String(c.affected_variant_id) === String(v.shopify_variant_id)) ||
      (v.sku && c.affected_sku && c.affected_sku === v.sku) ||
      (c.affected_product_title && productTitle && c.affected_product_title.toLowerCase() === productTitle.toLowerCase()));

  // Group variants by product_id (source of truth — legacy products.variants
  // JSONB is a mirror that doesn't always include freshly-added flavors).
  const variantsByProduct = new Map<string, Array<{ name: string; sku: string | null; qty: number | null; available: boolean; shopify_variant_id: string | null; restock: string | null }>>();
  for (const v of variantRows || []) {
    const list = variantsByProduct.get(v.product_id) || [];
    const productTitle = (titleById.get(v.product_id) || "") as string;
    const crisis = crisisForVariant(productTitle, { shopify_variant_id: (v.shopify_variant_id as string | null) || null, sku: v.sku as string | null });
    // On-hand from the canonical single source of truth (live), keyed by Shopify variant id;
    // the legacy product_variants.inventory_quantity scalar is stale and no longer read here.
    const qty = v.shopify_variant_id != null ? canonicalOnHand.get(String(v.shopify_variant_id)) ?? null : null;
    list.push({
      name: (v.title || v.option1 || "Default") as string,
      sku: v.sku as string | null,
      qty,
      // An active crisis still forces OUT OF STOCK — belt-and-suspenders over the live qty.
      available: !crisis && v.available !== false && (qty == null || qty > 0),
      shopify_variant_id: (v.shopify_variant_id as string | null) || null,
      restock: (crisis?.expected_restock_date as string | null) || null,
    });
    variantsByProduct.set(v.product_id, list);
  }

  // Products with their full flavor / variant list. Opus needs to see
  // every available flavor so it can answer "what flavors do you have?"
  // accurately. Previously we only emitted an OUT OF STOCK note and
  // left available flavors invisible — Opus then guessed from macros
  // and missed flavors that weren't in any macro (e.g. Cinnamon Roll).
  parts.push("PRODUCT CATALOG:");
  for (const p of products || []) {
    const variants = variantsByProduct.get(p.id) || [];
    const desc = p.description ? `: ${p.description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 150)}` : "";
    const url = productUrl((p as { handle?: string | null }).handle || null);
    parts.push(`- ${p.title}${desc}`);
    if (url) parts.push(`    URL: ${url}`);
    // Skip variant list if there's only one default variant — most
    // products with a single SKU don't have a meaningful "flavor".
    if (variants.length <= 1) continue;
    const inStock = variants.filter(v => v.available);
    const oos = variants.filter(v => !v.available);
    // Always emit variant_id alongside the flavor name. swap_variant /
    // add_item / remove_item all need the numeric ID — names alone make
    // Opus ask the admin for the ID instead of executing the action.
    const fmt = (v: { name: string; shopify_variant_id: string | null }) =>
      v.shopify_variant_id ? `${v.name} [variant_id: ${v.shopify_variant_id}]` : v.name;
    // OOS flavors surface their crisis restock date so Opus never claims a
    // crised SKU is back in stock or promises an imminent reship.
    const fmtOos = (v: { name: string; shopify_variant_id: string | null; restock: string | null }) =>
      `${fmt(v)}${v.restock ? ` (active OOS crisis — expected restock ${v.restock})` : ""}`;
    if (inStock.length) {
      parts.push(`    available: ${inStock.map(fmt).join(", ")}`);
    }
    if (oos.length) {
      parts.push(`    OUT OF STOCK: ${oos.map(fmtOos).join(", ")}`);
    }
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

/**
 * Live-ish stock levels for missing-item / availability triage.
 *
 * Why this exists separate from get_product_knowledge: that tool skips
 * the variant list for single-SKU products, so a single-variant item at
 * qty 0 (e.g. Apple Cider Vinegar Gummies) is invisible — the orchestrator
 * promised "I'll make it right" on a missing ACV Gummies with no way to
 * see it was out of stock (ticket 2875cde1). This always reports per-SKU
 * stock AND a full out-of-stock list, so the AI can confirm OOS before
 * offering a reship.
 *
 * In stock = `available !== false` AND (qty is untracked OR qty > 0). So
 * qty 0 reads as OUT OF STOCK even when Shopify's `available` flag is
 * still true (continue-selling policy). Inventory syncs hourly
 * ([[inngest/sync-inventory]]).
 */
async function checkInventory(admin: Admin, wsId: string, query: string): Promise<string> {
  const [{ data: products }, { data: variants }, { data: crises }, { data: ws }, canonicalOnHand] = await Promise.all([
    admin.from("products").select("id, title, inventory_updated_at").eq("workspace_id", wsId).eq("status", "active"),
    admin.from("product_variants")
      .select("product_id, title, option1, sku, available, position, shopify_variant_id")
      .eq("workspace_id", wsId).order("position"),
    admin.from("crisis_events")
      .select("affected_product_title, affected_variant_id, affected_sku, expected_restock_date")
      .eq("workspace_id", wsId).eq("status", "active"),
    admin.from("workspaces").select("shipping_protection_title").eq("id", wsId).maybeSingle(),
    // Canonical, live on-hand (single source of truth), keyed by Shopify variant id.
    getShopifyOnHandByVariant(admin, wsId),
  ]);
  // On-hand from canonical inventory_levels, never the stale product_variants scalar.
  const qtyOf = (v: { shopify_variant_id?: string | null }) =>
    v.shopify_variant_id != null ? canonicalOnHand.get(String(v.shopify_variant_id)) ?? null : null;

  // Exclude virtual / non-shippable products (shipping protection) — they
  // carry junk negative inventory and are never a "missing item".
  const spTitle = (ws?.shipping_protection_title || "Shipping protection").toLowerCase();
  const isVirtual = (title: string) => {
    const t = title.toLowerCase();
    return t === spTitle || t.includes("shipping protection");
  };
  const titleById = new Map((products || []).map((p) => [p.id, p.title as string]));
  // An active OOS crisis is the authoritative truth for a variant's stock —
  // inventory_quantity can lag Shopify and read positive on a SKU that's really
  // gone (ticket 9a7f9481: Mixed Berry showed qty 3746 mid-crisis, so the
  // orchestrator promised a reship that could never ship). Match by Shopify
  // variant id (crisis_events.affected_variant_id is a Shopify id, not our
  // UUID), then SKU, then product title as a fallback.
  const crisisFor = (productTitle: string, v: { shopify_variant_id?: string | null; sku?: string | null }) =>
    (crises || []).find((c) =>
      (v.shopify_variant_id && c.affected_variant_id && String(c.affected_variant_id) === String(v.shopify_variant_id)) ||
      (v.sku && c.affected_sku && c.affected_sku === v.sku) ||
      (c.affected_product_title && productTitle && c.affected_product_title.toLowerCase() === productTitle.toLowerCase()));
  const isInStock = (productTitle: string, v: { available?: boolean | null; shopify_variant_id?: string | null; sku?: string | null }) => {
    const q = qtyOf(v);
    return !crisisFor(productTitle, v) && v.available !== false && (q == null || q > 0);
  };
  const fmt = (productTitle: string, v: { title?: string | null; option1?: string | null; sku?: string | null; available?: boolean | null; shopify_variant_id?: string | null }) => {
    const variantName = (v.title || v.option1 || "").toString();
    const label = variantName && variantName !== "Default Title" ? `${productTitle} — ${variantName}` : productTitle;
    const q = qtyOf(v);
    const qty = q == null ? "untracked" : `${q}`;
    const inStock = isInStock(productTitle, v);
    const crisis = inStock ? undefined : crisisFor(productTitle, v);
    const status = inStock ? "in stock" : "OUT OF STOCK";
    // When a crisis drives the OOS call, say so and flag the inventory count as
    // non-authoritative — otherwise a stale positive qty reads as a contradiction.
    const note = inStock
      ? ""
      : crisis
        ? ` — active OOS crisis (inventory count is not authoritative)${crisis.expected_restock_date ? ` (expected restock: ${crisis.expected_restock_date})` : ""}`
        : "";
    return `- ${label}: ${status} (qty ${qty})${note}`;
  };

  // Tokenized match: any token (≥3 chars) hits the product OR variant name/sku.
  const tokens = (query || "").toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const matches = (productTitle: string, v: { title?: string | null; option1?: string | null; sku?: string | null }) => {
    if (!tokens.length) return false;
    const hay = `${productTitle} ${v.title || ""} ${v.option1 || ""} ${v.sku || ""}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
  };

  const parts: string[] = [];

  const real = (variants || []).filter((v) => !isVirtual(titleById.get(v.product_id) || ""));

  if (tokens.length) {
    const matched = real.filter((v) => matches(titleById.get(v.product_id) || "", v));
    parts.push(`MATCHES for "${query}":`);
    if (matched.length) {
      for (const v of matched) parts.push(fmt(titleById.get(v.product_id) || "Product", v));
    } else {
      parts.push("- (no product/variant matched that name — see the out-of-stock list below)");
    }
    parts.push("");
  }

  const oos = real.filter((v) => !isInStock(titleById.get(v.product_id) || "", v));
  if (oos.length) {
    parts.push("ALL CURRENTLY OUT-OF-STOCK ITEMS:");
    for (const v of oos) parts.push(fmt(titleById.get(v.product_id) || "Product", v));
  } else {
    parts.push("Every active product is currently in stock.");
  }

  const synced = (products || []).map((p) => p.inventory_updated_at).filter(Boolean).sort().pop();
  if (synced) parts.push(`\n(Inventory syncs hourly from Shopify — last update ${new Date(synced as string).toISOString()}.)`);

  return parts.join("\n");
}

async function getReturns(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const parts: string[] = [];

  // Returns
  const { data: returns } = await admin.from("returns")
    .select("id, status, order_number, return_line_items, net_refund_cents, tracking_number, carrier, label_url, shipped_at, delivered_at, refunded_at, created_at")
    .eq("workspace_id", wsId).in("customer_id", allCustIds)
    .order("created_at", { ascending: false }).limit(5);

  if (returns?.length) {
    parts.push("RETURNS:");
    for (const r of returns) {
      const items = (r.return_line_items as { title?: string; quantity?: number }[] || []).map(i => `${i.title || "item"} x${i.quantity || 1}`).join(", ");
      const date = new Date(r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const refund = r.net_refund_cents ? `$${(r.net_refund_cents / 100).toFixed(2)}` : "pending";
      // label_url is surfaced so that, once a label exists, the only move on
      // follow-ups is to re-deliver THIS exact link — never troubleshoot,
      // offer alternatives, or create a new return. See the "re-deliver the
      // label, don't keep solving" rule in sonnet_prompts.
      parts.push(`- ${date} | Status: ${r.status} | Order #${r.order_number || "?"} | Items: ${items} | Refund: ${refund}${r.tracking_number ? ` | Tracking: ${r.tracking_number} (${r.carrier || "?"})` : ""}${r.label_url ? ` | Return label (re-send this exact link if asked): ${r.label_url}` : ""}${r.shipped_at ? ` | Shipped: ${new Date(r.shipped_at).toLocaleDateString()}` : ""}${r.delivered_at ? ` | Delivered: ${new Date(r.delivered_at).toLocaleDateString()}` : ""}${r.refunded_at ? ` | Refunded: ${new Date(r.refunded_at).toLocaleDateString()}` : ""}`);
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
  // fraud_cases.customer_ids is a uuid[] — overlap finds any case with
  // any of the linked customer IDs. Project enough to tell the
  // orchestrator how serious the situation is.
  const { data: cases } = await admin.from("fraud_cases")
    .select("id, rule_type, severity, status, title, first_detected_at, last_seen_at, evidence")
    .eq("workspace_id", wsId)
    .overlaps("customer_ids", allCustIds)
    .order("first_detected_at", { ascending: false })
    .limit(8);

  if (!cases?.length) return "No fraud cases for this customer.";

  const confirmed = cases.filter(c => c.status === "confirmed_fraud");
  const open = cases.filter(c => c.status === "open" || c.status === "reviewing");

  const parts: string[] = [];
  if (confirmed.length) {
    parts.push("⚠️  CONFIRMED FRAUD — orchestrator is gated for this customer; the unified handler will short-circuit and refuse all actions:");
    for (const c of confirmed) {
      const date = new Date(c.first_detected_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      parts.push(`  - ${date} | ${c.rule_type} | ${c.severity} | ${c.title}`);
    }
  }
  if (open.length) {
    parts.push(`OPEN FRAUD CASES (${open.length}) — under investigation, not yet confirmed:`);
    for (const c of open) {
      const date = new Date(c.first_detected_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      parts.push(`  - ${date} | ${c.rule_type} | ${c.severity} | ${c.title}`);
    }
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
    if (a.paused_at) out.push(`  PAUSED at ${new Date(a.paused_at).toLocaleDateString()}`);
    if (a.removed_item_at) out.push(`  REMOVED at ${new Date(a.removed_item_at).toLocaleDateString()}`);
    if (a.cancelled) out.push("  CANCELLED");
    if (a.exhausted_at) out.push("  All tiers exhausted");

    // ALWAYS surface auto_readd + auto_resume regardless of pause/remove
    // state. Without this Opus had no way to know whether the system
    // would auto-reach-out post-resolution (see Debra's 5/11 ticket —
    // it promised "we'll reach out" by coincidence, not certainty).
    out.push(`  auto_resume: ${a.auto_resume}  (will the system unpause this subscription when the crisis ends?)`);
    out.push(`  auto_readd: ${a.auto_readd}  (will the system re-add / offer the original product when the crisis ends?)`);

    // Derived: what literally happens when the crisis resolves. Lets
    // Opus answer "will you reach out?" with certainty instead of a
    // reasonable-sounding guess.
    //
    // The customer does nothing. If auto_readd is true the system
    // automatically switches their subscription line back to the
    // original variant when the admin resolves the crisis — they
    // just receive the original product on the next shipment with
    // no journey, no email, no confirmation needed. Always say
    // "automatically" in customer-facing copy, never "silently".
    const resolutionActions: string[] = [];
    if (a.auto_resume && a.paused_at) {
      resolutionActions.push("auto-resume the paused subscription");
    }
    if (a.auto_readd) {
      if (a.removed_item_at) {
        resolutionActions.push("automatically re-add the removed original item to the subscription");
      } else {
        // Swap case — berry_only / berry_plus customer who was
        // auto-swapped to default_swap rather than paused/removed.
        resolutionActions.push("automatically switch the subscription line back to the original variant (customer does nothing, just receives the original on the next shipment)");
      }
    }
    if (resolutionActions.length === 0) {
      out.push(`  ON RESOLUTION: nothing automatic — customer must reach out themselves.`);
    } else {
      out.push(`  ON RESOLUTION: ${resolutionActions.join("; ")}.`);
    }

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
      .select("id, subscription_id, shopify_contract_id, status, cycle_number, payment_update_sent, payment_update_sent_at, next_retry_at, created_at")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .order("created_at", { ascending: false }).limit(3),
    admin.from("payment_failures")
      .select("id, attempt_type, error_code, error_message, result, payment_method_last4, created_at")
      .eq("workspace_id", wsId).in("customer_id", allCustIds)
      .eq("result", "failed")
      .order("created_at", { ascending: false }).limit(8),
  ]);

  if (!cycles?.length && !failures?.length) return "No dunning or payment failure data for this customer.";

  const parts: string[] = [];
  if (cycles?.length) {
    parts.push("DUNNING CYCLES:");
    for (const c of cycles) {
      const isInternal = String(c.shopify_contract_id || "").startsWith("internal-");
      const linkSent = c.payment_update_sent
        ? ` | Recovery link SENT${c.payment_update_sent_at ? ` ${new Date(c.payment_update_sent_at).toLocaleDateString()}` : ""}`
        : " | No recovery link sent yet";
      const nextRetry = c.next_retry_at ? ` | Next retry ${new Date(c.next_retry_at).toLocaleDateString()}` : "";
      parts.push(`- Subscription ${c.subscription_id}${isInternal ? " (internal)" : ""} | Cycle #${c.cycle_number} | Status: ${c.status}${linkSent}${nextRetry} | ${new Date(c.created_at).toLocaleDateString()}`);
    }
  }
  // Already filtered to result='failed' (real declines) — pending/accepted
  // attempts and recovered charges are excluded so the count is accurate.
  if (failures?.length) {
    parts.push("\nPAYMENT FAILURES (declines):");
    for (const f of failures) {
      const reason = f.error_message || f.error_code || "declined";
      parts.push(`- ${new Date(f.created_at).toLocaleDateString()} | ${f.attempt_type} | ${reason} | Card: *${f.payment_method_last4 || "?"}`);
    }
  }
  return parts.join("\n");
}

/**
 * Payment methods on file. Pulls from BOTH sources so the customer
 * gets a complete picture regardless of how they checked out:
 *   - Our local customer_payment_methods (Braintree-vaulted from
 *     storefront checkout, provider='braintree')
 *   - Shopify's Customer.paymentMethods (Shopify Payments — what the
 *     legacy storefront uses)
 *
 * Customers most often ask about this when (a) they want to change
 * the default card, (b) they deleted an old card and it's still
 * showing, (c) they added a new card and want to confirm we see it.
 */
async function getPaymentMethods(admin: Admin, wsId: string, custId: string): Promise<string> {
  const allCustIds = await resolveLinkedCustomerIds(admin, custId);

  // Local (Braintree-vaulted)
  const { data: local } = await admin
    .from("customer_payment_methods")
    .select("provider, card_brand, last4, expiration_month, expiration_year, is_default, status, created_at")
    .eq("workspace_id", wsId)
    .in("customer_id", allCustIds)
    .order("created_at", { ascending: false });

  // Shopify side
  const { data: customers } = await admin
    .from("customers")
    .select("shopify_customer_id")
    .in("id", allCustIds);
  const shopifyIds = (customers || [])
    .map((c) => c.shopify_customer_id as string | null)
    .filter((s): s is string => !!s);

  type ShopifyPM = { brand: string; last4: string; exp: string; status: string; name: string };
  const shopifyMethods: ShopifyPM[] = [];
  if (shopifyIds.length > 0) {
    try {
      const { decrypt } = await import("@/lib/crypto");
      const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
      const { data: ws } = await admin
        .from("workspaces")
        .select("shopify_myshopify_domain, shopify_access_token_encrypted")
        .eq("id", wsId)
        .single();
      const shop = ws?.shopify_myshopify_domain as string | undefined;
      if (shop && ws?.shopify_access_token_encrypted) {
        const token = decrypt(ws.shopify_access_token_encrypted as string);
        for (const sid of shopifyIds) {
          const query = `query { customer(id: "gid://shopify/Customer/${sid}") { paymentMethods(first: 30) { edges { node { id revokedAt instrument { ... on CustomerCreditCard { brand lastDigits expiryMonth expiryYear name } } } } } } }`;
          const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          const edges = data?.data?.customer?.paymentMethods?.edges as Array<{ node: { revokedAt: string | null; instrument: { brand?: string; lastDigits?: string; expiryMonth?: number; expiryYear?: number; name?: string } } }> | undefined;
          for (const e of edges || []) {
            const inst = e.node.instrument || {};
            shopifyMethods.push({
              brand: (inst.brand || "card").toLowerCase(),
              last4: inst.lastDigits || "?",
              exp: `${inst.expiryMonth || "?"}/${inst.expiryYear || "?"}`,
              status: e.node.revokedAt ? "revoked" : "active",
              name: inst.name || "",
            });
          }
        }
      }
    } catch (err) {
      // Non-fatal — fall back to local-only.
      void err;
    }
  }

  const parts: string[] = [];
  if (local?.length) {
    parts.push("STOREFRONT-VAULTED CARDS (charged via Braintree on internal subscriptions):");
    for (const p of local) {
      parts.push(`- ${p.card_brand || "card"} ending ${p.last4} | exp ${p.expiration_month}/${p.expiration_year} | ${p.is_default ? "DEFAULT" : "not default"} | ${p.status}`);
    }
  }
  if (shopifyMethods.length) {
    parts.push(`${parts.length ? "\n" : ""}SHOPIFY PAYMENT METHODS (charged via Shopify Payments on legacy subscriptions):`);
    for (const m of shopifyMethods) {
      parts.push(`- ${m.brand} ending ${m.last4} | exp ${m.exp} | ${m.status}${m.name ? ` | name: ${m.name}` : ""}`);
    }
  }
  if (parts.length === 0) {
    return "No payment methods on file for this customer.";
  }
  parts.push(
    "\nManage payment methods URL: https://account.superfoodscompany.com/profile (customer can add/remove/set-default there). " +
    "Shopify Payments does NOT expose a way to programmatically set the default; the customer must do it from their account portal.",
  );
  return parts.join("\n");
}

/**
 * LIVE refund ledger for one order — reconciles Shopify's transaction list against our local
 * order_refunds mirror so an out-of-band refund (issued directly in the Shopify admin) becomes
 * visible to Sonnet. Wraps [[refund-ledger]] `getOrderRefundLedger`; the ceiling for any new
 * refund on this order is `refundableCents`, and `outOfBandCents > 0` is the exact signal that
 * would have resolved SC133086 at first touch.
 */
async function getOrderRefundLedgerTool(
  admin: Admin,
  wsId: string,
  custId: string,
  orderNumber: string,
): Promise<string> {
  const trimmed = orderNumber.trim();
  if (!trimmed) return "No order_number provided. Pass the customer-facing order number from RECENT ORDERS (e.g. 'SC133086').";

  const allCustIds = await resolveLinkedCustomerIds(admin, custId);
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, shopify_order_id, total_cents")
    .eq("workspace_id", wsId)
    .in("customer_id", allCustIds)
    .eq("order_number", trimmed)
    .maybeSingle();
  if (!order) return `Order ${trimmed} not found on this customer (or any linked account).`;
  if (!order.shopify_order_id) return `Order ${trimmed} has no Shopify order id — refund ledger unavailable (likely an internal-only order).`;

  const { getOrderRefundLedger } = await import("@/lib/refund-ledger");
  const ledger = await getOrderRefundLedger(wsId, order.id);
  if (!ledger.ok) {
    return `Order ${trimmed}: refund ledger unavailable (${ledger.reason}${ledger.error ? ` — ${ledger.error}` : ""}).`;
  }

  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  const lines: string[] = [];
  lines.push(`ORDER ${order.order_number} — LIVE REFUND LEDGER (source: Shopify transactions)`);
  lines.push(`  charged:     ${dollars(ledger.saleCents)}`);
  lines.push(`  refunded:    ${dollars(ledger.refundedCents)} (settled)`);
  if (ledger.pendingCents > 0) {
    lines.push(`  pending:     ${dollars(ledger.pendingCents)} (gateway settling — NOT available as headroom)`);
  }
  lines.push(`  REFUNDABLE:  ${dollars(ledger.refundableCents)}  ← CEILING for any new refund on this order`);
  if (ledger.outOfBandCents > 0) {
    lines.push(
      `  OUT-OF-BAND: ${dollars(ledger.outOfBandCents)}  ← someone refunded outside ShopCX (usually a manual refund in the Shopify admin). Our internal refund-owed math will be wrong until you use THIS reading.`,
    );
  }
  if (ledger.refunds.length) {
    lines.push(`  Refund transactions on this order:`);
    for (const r of ledger.refunds) {
      const when = r.processedAt ? new Date(r.processedAt).toISOString().slice(0, 10) : "?";
      const gw = r.gateway || "?";
      const mirror = r.status === "success" ? (r.mirroredLocally ? "mirrored" : "OUT-OF-BAND") : "n/a";
      lines.push(`    - ${when} · ${dollars(r.amountCents)} · ${gw} · ${r.status} · ${mirror}`);
    }
  } else {
    lines.push(`  (no refund transactions on this order yet)`);
  }
  return lines.join("\n");
}

// ── Main Orchestrator ──

/**
 * The per-ticket decision agent (control-tower-agent-coverage Phase 2: `ai:orchestrator`).
 * Wraps the inner decision run in a try/finally so every run emits exactly ONE inline-agent
 * heartbeat — ok:false when it threw OR returned a degraded/fallback decision (so the
 * error-rate + liveness-when-work-exists assertions can see a silently-broken orchestrator),
 * ok:true on a real model decision. The heartbeat write is best-effort and never affects the
 * returned decision.
 */
export async function callSonnetOrchestratorV2(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  message: string,
  channel: string,
  personality?: { name?: string; tone?: string; sign_off?: string | null } | null,
  agentContext?: { assigned: boolean; intervened: boolean } | null,
  modelChoice?: { model: OrchestratorModelKey; reason: string } | null,
  // Phase 5 Fix 1 of docs/brain/specs/sol-cheap-execution-over-ticket-direction.md.
  // When passed non-null + non-superseded, buildPreContext swaps the customer/orders/
  // full-history user block for the Direction's rendered suffix, and the returned
  // decision.reasoning is prefixed with 'sol:direction-context' so stageResolutionEvent
  // stamps the ticket_resolution_events ledger with the spec-verification tag.
  directionOverride?: TicketDirection | null,
): Promise<SonnetDecision> {
  const startedAt = Date.now();
  let decision: SonnetDecision | null = null;
  let threw: unknown = null;
  try {
    decision = await runOrchestratorDecision(
      workspaceId, ticketId, customerId, message, channel, personality, agentContext, modelChoice, directionOverride,
    );
    if (directionOverride && !directionOverride.superseded_at && decision) {
      // Prefix the reasoning so downstream stageResolutionEvent stamps
      // ticket_resolution_events.reasoning starting with 'sol:direction-context' — the
      // exact string the spec Phase 2 / Fix-1 verification asserts on. Guarded on the
      // same predicate buildPreContext used above so a superseded direction never
      // taints the ledger tag. prefixDirectionContextReasoning is pure + pinned to a
      // constant in ai-context.ts so a unit test can assert the exact tag byte-for-byte.
      decision = { ...decision, reasoning: prefixDirectionContextReasoning(decision.reasoning) };
    }
    return decision;
  } catch (err) {
    threw = err;
    throw err;
  } finally {
    const degraded = !!threw || (decision != null && DEGRADED_DECISIONS.has(decision));
    void emitInlineAgentHeartbeat(INLINE_AGENT_IDS.orchestrator, {
      ok: !degraded,
      produced: decision
        ? { action_type: decision.action_type, handler_name: decision.handler_name ?? null, model: modelChoice?.model ?? "sonnet" }
        : null,
      detail: threw
        ? `threw: ${errText(threw)}`
        : degraded
          ? `degraded: ${(decision?.reasoning ?? "").slice(0, 160)}`
          : `decided: ${decision?.action_type}`,
      durationMs: Date.now() - startedAt,
    });
  }
}

async function runOrchestratorDecision(
  workspaceId: string,
  ticketId: string,
  customerId: string,
  message: string,
  channel: string,
  personality?: { name?: string; tone?: string; sign_off?: string | null } | null,
  agentContext?: { assigned: boolean; intervened: boolean } | null,
  modelChoice?: { model: OrchestratorModelKey; reason: string } | null,
  directionOverride?: TicketDirection | null,
): Promise<SonnetDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set");
    return fallbackWithCancelRoute(message, "ANTHROPIC_API_KEY not set");
  }
  const modelKey: OrchestratorModelKey = modelChoice?.model || "sonnet";
  const modelId = MODEL_IDS[modelKey];
  const purpose = `orchestrator-decision:${modelKey}(${modelChoice?.reason || "default"})`;
  const logUsage = (usage: ClaudeUsage | undefined, tag: string) => {
    void logAiUsage({ workspaceId, model: modelId, usage, purpose: `${purpose}:${tag}`, ticketId });
  };

  try {
    const { system, userBlockPrefix, userBlock } = await buildPreContext(workspaceId, ticketId, customerId, message, channel, personality, agentContext, directionOverride);
    // Cache-control breakpoints, 1-hour TTL. The heavy, shared payload
    // (tools + system rules/policies/handlers, ~40-50K tokens) is now
    // byte-identical for every ticket in the workspace, so the first
    // ticket each hour writes it and every subsequent ticket / turn /
    // tool-use round reads it at 10% of input price. The volatile
    // per-ticket context (customer + conversation + date) lives in the
    // uncached user turn below, so it never invalidates the shared prefix.
    // Before this split the whole prompt was one user block with volatile
    // content ahead of the rules → cache_creation ≈ cache_read and the
    // stable payload was re-billed at full freight on every ticket.
    const apiHeaders = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
      "Content-Type": "application/json",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const systemBlocks: any[] = [
      { type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } },
    ];
    const baseTools = buildToolDefinitions();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = baseTools.map((t, i) => i === baseTools.length - 1
      ? { ...t, cache_control: { type: "ephemeral", ttl: "1h" } }
      : t) as any[];

    // Per-ticket cache breakpoint (Phase 2 of ticket-merge-summary-and-context-cap):
    // when a merged ticket has a durable merge_summary, that summary is a
    // stable prefix within the ticket's lifetime. Marking it as an ephemeral
    // cache block lets it be cache_created once and cache_read on every
    // subsequent turn — the tail after it stays uncached and small. Kills the
    // full-history recost loop measured on ticket 49ddd6c4 ($8.92). Non-merged
    // tickets keep the single-block user turn (no per-ticket prefix worth caching).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userContent: any[] = userBlockPrefix
      ? [
          { type: "text", text: userBlockPrefix, cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: userBlock },
        ]
      : [
          { type: "text", text: userBlock },
        ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messages: any[] = [
      {
        role: "user",
        content: userContent,
      },
    ];

    const MAX_ROUNDS = 3;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          model: modelId,
          max_tokens: 2000,
          system: systemBlocks,
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
            headers: apiHeaders,
            body: JSON.stringify({ model: modelId, max_tokens: 2000, system: systemBlocks, tools, messages }),
          });
          if (retry.ok) {
            const retryData = await retry.json();
            logUsage(retryData.usage, `round${round}-retry529`);
            // Replace content blocks and continue processing this round
            const retryContent = retryData.content || [];
            const retryToolUse = retryContent.filter((b: { type: string }) => b.type === "tool_use");
            const retryText = retryContent.filter((b: { type: string }) => b.type === "text");
            if (retryToolUse.length === 0) {
              return parseSonnetDecision(retryText.map((b: { text: string }) => b.text).join(""), message);
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
        // Outage resilience (agent-outage-resilience Phase 1): a retryable
        // dependency failure (429/5xx/overloaded) must THROW so the Inngest
        // run retries with outage-spanning backoff and decides correctly on
        // recovery — NOT silently degrade every ticket to a generic escalation
        // (the old `return fallback…` swallow). A terminal status (4xx other
        // than 429) is a request/auth bug that won't succeed on retry, so it
        // still degrades gracefully to escalation.
        // Log level mirrors that split: a retryable status is the designed
        // Inngest-retry self-heal, so it logs via console.warn — NOT error —
        // to avoid minting a false Control Tower 'vercel' incident off the
        // Vercel log drain (orchestrator-retryable-anthropic-throw-not-control-tower-err,
        // sibling of chat-fallback-absorbed-anthropic-overload-noise). Only the
        // terminal degrade below keeps console.error.
        if (isRetryableAnthropicStatus(res.status)) {
          console.warn(`Orchestrator (${modelKey}) retryable API error: ${res.status}`, errBody.slice(0, 300));
          throw new AnthropicDependencyError(`${modelKey} API error ${res.status}: ${errBody.slice(0, 100)}`, res.status);
        }
        console.error(`Orchestrator (${modelKey}) API error: ${res.status}`, errBody.slice(0, 300));
        return fallbackWithCancelRoute(message, `${modelKey} API error ${res.status}: ${errBody.slice(0, 100)}`);
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
        // Anthropic occasionally returns a 200 with no content at all
        // (no tool_use, no text). Without this retry, parseSonnetDecision
        // would fall through to FALLBACK_DECISION and escalate a
        // perfectly handleable message (see Joseph 2d4a45dc, 2026-05-18).
        // Single retry with a short delay — same messages, same tools.
        if (text.trim().length === 0) {
          console.warn(`Orchestrator (${modelKey}): empty content, retrying in 1.5s...`);
          await new Promise(r => setTimeout(r, 1500));
          const retry = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: apiHeaders,
            body: JSON.stringify({ model: modelId, max_tokens: 2000, system: systemBlocks, tools, messages }),
          });
          if (retry.ok) {
            const retryData = await retry.json();
            logUsage(retryData.usage, `round${round}-retry-empty`);
            const retryContent = retryData.content || [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const retryToolUse = retryContent.filter((b: any) => b.type === "tool_use");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const retryText = retryContent.filter((b: any) => b.type === "text");
            if (retryToolUse.length === 0) {
              return parseSonnetDecision(retryText.map((b: { text: string }) => b.text).join(""), message);
            }
            // Has tool calls — execute them and continue this round's loop
            const retryResults: unknown[] = [];
            for (const tc of retryToolUse) {
              const result = await executeToolCall(tc.name, tc.input || {}, workspaceId, customerId, ticketId);
              retryResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
            }
            messages.push({ role: "assistant", content: retryContent });
            messages.push({ role: "user", content: retryResults });
            continue;
          }
          console.warn(`Orchestrator (${modelKey}): empty-content retry failed (status ${retry.status})`);
        }
        // Parse the response. If the model returned prose without a JSON
        // block (Christine 5a279c92, 2026-06-03 — Opus reasoned through
        // the situation in plain English but never emitted JSON), retry
        // once with no tools + an explicit "JSON only" reminder. Same
        // shape as the max-tool-rounds force-decision retry below.
        const firstAttempt = tryParseSonnetDecision(text);
        if (firstAttempt) return firstAttempt;
        console.warn(`Orchestrator (${modelKey}): no JSON in text, retrying with JSON-only reminder. Got: ${text.slice(0, 500).replace(/\s+/g, " ")}`);
        try {
          const jsonRetry = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: apiHeaders,
            body: JSON.stringify({
              model: modelId,
              max_tokens: 2000,
              system: systemBlocks,
              messages: [
                ...messages,
                { role: "assistant", content: text },
                { role: "user", content: "Your previous response was prose, not JSON. Re-emit your decision as a single JSON object with at minimum the keys `reasoning` and `action_type`. Output ONLY the JSON object, nothing else." },
              ],
            }),
          });
          if (jsonRetry.ok) {
            const jsonRetryData = await jsonRetry.json();
            logUsage(jsonRetryData.usage, `round${round}-retry-json`);
            const retryText = (jsonRetryData.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
            const second = tryParseSonnetDecision(retryText);
            if (second) return second;
            console.warn(`Orchestrator (${modelKey}): JSON-only retry still no JSON. Got: ${retryText.slice(0, 500).replace(/\s+/g, " ")}`);
          } else {
            console.warn(`Orchestrator (${modelKey}): JSON-only retry HTTP ${jsonRetry.status}`);
          }
        } catch (e) {
          console.warn(`Orchestrator (${modelKey}): JSON-only retry threw:`, e);
        }
        return parseSonnetDecision(text, message);
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
    let forceStatus = "unknown";
    try {
      const forceRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          model: modelId,
          max_tokens: 2000,
          system: systemBlocks,
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "You have gathered enough data. Provide your decision NOW as a single JSON object with at minimum the keys `reasoning` and `action_type`. Do not call any more tools. Do not include prose outside the JSON.",
            },
          ],
          // No tools — forces text response
        }),
      });
      forceStatus = `http ${forceRes.status}`;
      if (forceRes.ok) {
        const forceData = await forceRes.json();
        logUsage(forceData.usage, "force-decision");
        const text = (forceData.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
        if (text) return parseSonnetDecision(text, message);
        forceStatus = "ok but empty text";
      } else {
        const errBody = await forceRes.text().catch(() => "");
        // Same outage-resilience rule as the main round loop above: a
        // retryable dependency failure (429/5xx/overloaded) on the
        // force-decision call must THROW so the Inngest run retries across
        // the outage rather than silently degrading this ticket to a
        // generic escalation. A terminal 4xx still falls through to the
        // graceful fallback below. (orchestrator-retry-5xx Phase 1.)
        // Log level split mirrors the main loop: a retryable status logs via
        // console.warn (the throw + Inngest retry handle it) so it doesn't mint
        // a false Control Tower 'vercel' incident off the Vercel log drain
        // (orchestrator-retryable-anthropic-throw-not-control-tower-err, sibling
        // of chat-fallback-absorbed-anthropic-overload-noise). Only the terminal
        // degrade keeps console.error.
        if (isRetryableAnthropicStatus(forceRes.status)) {
          console.warn(`Orchestrator (${modelKey}) force-decision retryable API error: ${forceRes.status}`, errBody.slice(0, 300));
          throw new AnthropicDependencyError(`${modelKey} force-decision API error ${forceRes.status}: ${errBody.slice(0, 100)}`, forceRes.status);
        }
        console.error(`Orchestrator (${modelKey}) force-decision API error: ${forceRes.status}`, errBody.slice(0, 300));
        forceStatus = `http ${forceRes.status}: ${errBody.slice(0, 100)}`;
      }
    } catch (err) {
      // Re-throw retryable dependency failures (our own AnthropicDependencyError
      // thrown just above, plus raw network/fetch failures) so the outer catch
      // propagates them and Inngest retries — don't swallow a transient outage
      // into the fallback. Genuine logic errors still degrade gracefully.
      if (isRetryableThrownError(err)) throw err;
      forceStatus = `throw: ${errText(err)}`;
    }
    return fallbackWithCancelRoute(message, `Max ${MAX_ROUNDS} tool rounds exceeded; force-decision retry: ${forceStatus}`);
  } catch (err) {
    // Re-throw retryable dependency failures — our own AnthropicDependencyError
    // (thrown above on a retryable status) and raw network/fetch failures — so
    // the Inngest run retries across the outage rather than silently escalating
    // every ticket. Genuine logic errors still degrade to escalation.
    // (agent-outage-resilience Phase 1.)
    if (isRetryableThrownError(err)) throw err;
    console.error(`Orchestrator (${modelKey}) error:`, err);
    return fallbackWithCancelRoute(message, `${modelKey} error: ${errText(err)}`);
  }
}

// ── JSON Parser ──

/**
 * Try to parse a decision from `text`. Returns null (not a fallback)
 * on any parse failure so the caller can decide whether to retry the
 * API call before escalating.
 */
function tryParseSonnetDecision(text: string): SonnetDecision | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.reasoning || !parsed.action_type) return null;
    return parsed as SonnetDecision;
  } catch {
    return null;
  }
}

// Parse failures below log via console.warn (not error) — reached only after the JSON-only retry above already failed, and the fallback returns a valid escalation decision. Same rationale as the retryable-Anthropic split at line 1750 (orchestrator-retryable-anthropic-throw-not-control-tower-err): a self-healed edge case must not mint a false Control Tower 'vercel' incident off the Vercel log drain.
function parseSonnetDecision(text: string, inboundMessage: string = ""): SonnetDecision {
  // Each failure mode tags the reasoning so when a ticket lands in
  // the escalation pile we know which guardrail tripped — bare
  // "Orchestrator error" left us blind on Barbara's cancel ticket.
  // Cancel-intent inbounds bypass the generic escalation and go
  // straight to the cancel journey via fallbackWithCancelRoute.
  const snippet = (text || "").slice(0, 180).replace(/\s+/g, " ").trim();
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("Sonnet v2: no JSON found in response:", snippet);
      return fallbackWithCancelRoute(inboundMessage, `Parse fail: no JSON block in response. Got: "${snippet}"`);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.reasoning || !parsed.action_type) {
      console.warn("Sonnet v2: missing required fields:", parsed);
      return fallbackWithCancelRoute(inboundMessage, `Parse fail: missing reasoning/action_type. Got keys: ${Object.keys(parsed).join(", ")}`);
    }

    const decision = parsed as SonnetDecision;
    // Adoption WARN (Phase 2 of ticket-resolution-events-writeahead-ledger
    // -and-decision-schema-extension). buildSystemPrompt asks the model
    // for problem/confidence/options/chosen; the interface tolerates
    // them being absent so a straggler prompt still executes, but a real
    // (non-fallback) decision without them means the ticket_resolution
    // _events row lands with NULL diagnosis and calibration loses signal.
    // Each miss increments the [resolution-schema-adoption] counter in
    // structured logs — Vercel log drain / control tower aggregate it so
    // adoption is watchable across the fleet without a schema change.
    warnOnMissingResolutionFields(decision);
    return decision;
  } catch (err) {
    console.warn("Sonnet v2: JSON parse error:", err, "text:", snippet);
    return fallbackWithCancelRoute(inboundMessage, `Parse fail: ${errText(err)}. Got: "${snippet}"`);
  }
}

// Counters for the Phase-2 adoption watch. Bumped once per real,
// successfully-parsed decision missing a field. In-process only — the
// authoritative signal is the console.warn line's [resolution-schema
// -adoption] prefix (Vercel log drain aggregates it). Exported so a
// caller or a test can read the current tallies without scraping logs.
export const resolutionSchemaAdoption = {
  total: 0,
  missingProblem: 0,
  missingConfidence: 0,
  missingOptions: 0,
  missingChosen: 0,
};

// Exported so a unit-shaped test can drive it against a mocked SonnetDecision
// without hitting the network — the smallest-test-for-the-named-failing-state
// mandate for the "model omits the new fields" verification bullet.
export function warnOnMissingResolutionFields(decision: SonnetDecision): string[] {
  const missing: string[] = [];
  if (typeof decision.problem !== "string" || decision.problem.length === 0) {
    missing.push("problem");
    resolutionSchemaAdoption.missingProblem += 1;
  }
  if (typeof decision.confidence !== "number" || Number.isNaN(decision.confidence)) {
    missing.push("confidence");
    resolutionSchemaAdoption.missingConfidence += 1;
  }
  if (!Array.isArray(decision.options)) {
    missing.push("options");
    resolutionSchemaAdoption.missingOptions += 1;
  }
  if (
    decision.chosen == null ||
    typeof decision.chosen !== "object" ||
    typeof decision.chosen.option_index !== "number"
  ) {
    missing.push("chosen");
    resolutionSchemaAdoption.missingChosen += 1;
  }
  if (missing.length > 0) {
    resolutionSchemaAdoption.total += 1;
    console.warn(
      `[resolution-schema-adoption] real Sonnet decision missing fields: ${missing.join(",")} — action_type=${decision.action_type} count=${resolutionSchemaAdoption.total}`,
    );
  }
  return missing;
}
