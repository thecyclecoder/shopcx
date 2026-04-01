/**
 * AI remedy selection — Claude Haiku picks top 3 remedies for cancel retention.
 * Open-ended reasons get a Sonnet-powered empathetic conversation instead.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getReviewsForProducts } from "@/lib/klaviyo";

interface RemedySelection {
  remedy_id: string;
  name: string;
  description: string | null;
  type: string;
  pitch: string;
  coupon_code?: string;
  confidence: number;
}

interface CustomerContext {
  ltv_cents: number;
  retention_score: number;
  subscription_age_days: number;
  total_orders: number;
  products: string[];
  first_renewal?: boolean;
}

// Minimum number of "shown" events before we trust historical acceptance rates
const STATS_THRESHOLD = 200;

/** @deprecated Reason type is now driven by settings config, not hardcoded lists */
export function isConcreteReason(_reason: string): boolean {
  // All reasons go through settings config now — this exists for backward compat with journey routes
  return true;
}

export async function selectRemedies(
  workspaceId: string,
  cancelReason: string,
  customer: CustomerContext,
  shopifyProductIds: string[],
  suggestedRemedyId?: string | null,
): Promise<{ remedies: RemedySelection[]; review: { summary: string; rating: number; body: string; reviewer_name: string } | null }> {
  const admin = createAdminClient();

  // Fetch enabled remedies
  const { data: remedies } = await admin
    .from("remedies")
    .select("id, name, type, config, description")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("priority", { ascending: true });

  if (!remedies?.length) return { remedies: [], review: null };

  // Fetch historical acceptance rates using shown/outcome tracking
  // Strategy: use per-reason+remedy stats if >= STATS_THRESHOLD, else fall back to global remedy stats
  const { data: reasonStats } = await admin
    .from("remedy_outcomes")
    .select("remedy_id, outcome")
    .eq("workspace_id", workspaceId)
    .eq("cancel_reason", cancelReason)
    .eq("shown", true);

  const { data: globalStats } = await admin
    .from("remedy_outcomes")
    .select("remedy_id, outcome")
    .eq("workspace_id", workspaceId)
    .eq("shown", true);

  // Build per-reason stats: { remedy_id -> { shown, accepted } }
  const reasonRates: Record<string, { shown: number; accepted: number }> = {};
  for (const o of reasonStats || []) {
    if (!o.remedy_id) continue;
    if (!reasonRates[o.remedy_id]) reasonRates[o.remedy_id] = { shown: 0, accepted: 0 };
    reasonRates[o.remedy_id].shown++;
    if (o.outcome === "accepted") reasonRates[o.remedy_id].accepted++;
  }

  // Build global stats: { remedy_id -> { shown, accepted } }
  const globalRates: Record<string, { shown: number; accepted: number }> = {};
  for (const o of globalStats || []) {
    if (!o.remedy_id) continue;
    if (!globalRates[o.remedy_id]) globalRates[o.remedy_id] = { shown: 0, accepted: 0 };
    globalRates[o.remedy_id].shown++;
    if (o.outcome === "accepted") globalRates[o.remedy_id].accepted++;
  }

  // Compute acceptance rate per remedy: prefer granular, fall back to global, then "no data"
  const successRates: Record<string, { offered: number; saved: number }> = {};
  for (const r of remedies) {
    const perReason = reasonRates[r.id];
    const global = globalRates[r.id];
    if (perReason && perReason.shown >= STATS_THRESHOLD) {
      successRates[r.type] = { offered: perReason.shown, saved: perReason.accepted };
    } else if (global && global.shown >= STATS_THRESHOLD) {
      successRates[r.type] = { offered: global.shown, saved: global.accepted };
    }
    // else: no data — AI uses its own judgment
  }

  // Fetch available coupons
  const { data: wsData } = await admin.from("workspaces").select("vip_retention_threshold").eq("id", workspaceId).single();
  const vipThreshold = wsData?.vip_retention_threshold || 85;
  const isVip = customer.retention_score >= vipThreshold;

  const { data: coupons } = await admin
    .from("coupon_mappings")
    .select("code, summary, value_type, value, customer_tier")
    .eq("workspace_id", workspaceId)
    .eq("ai_enabled", true);

  const eligibleCoupons = (coupons || []).filter(c =>
    c.customer_tier === "all" ||
    (c.customer_tier === "vip" && isVip) ||
    (c.customer_tier === "non_vip" && !isVip)
  );

  // Fetch reviews for social proof
  const reviews = await getReviewsForProducts(workspaceId, shopifyProductIds);
  const bestReview = reviews[0] || null;

  // Build AI prompt
  const remedyList = remedies
    .map(r => {
      const rates = successRates[r.type];
      const rate = rates && rates.offered > 0 ? Math.round((rates.saved / rates.offered) * 100) : null;
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        success_rate: rate !== null ? `${rate}%` : "no data",
      };
    });

  const couponList = eligibleCoupons.map(c => ({
    code: c.code,
    summary: c.summary,
    value: `${c.value_type === "percentage" ? `${c.value}%` : `$${c.value}`} off`,
  }));

  const reviewList = reviews.slice(0, 3).map(r => ({
    rating: r.rating,
    summary: r.summary,
    product: r.shopify_product_id,
  }));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { remedies: [], review: bestReview ? { summary: bestReview.summary, rating: bestReview.rating, body: bestReview.body, reviewer_name: bestReview.reviewer_name } : null };

  const reasonLabels: Record<string, string> = {
    too_expensive: "Too expensive",
    too_much_product: "Too much product",
    not_seeing_results: "Not seeing results",
    reached_goals: "Already reached goals",
    taste_texture: "Doesn't like taste/texture",
    health_change: "Health needs changed",
  };

  try {
    const firstRenewalContext = customer.first_renewal
      ? `\n\nIMPORTANT: This customer has NEVER renewed — they are in the highest churn risk window (pre-first-renewal). 50% of all churn happens here. Be more aggressive with save offers:
- Deeper discounts (25-40%, not 10-15%) — acquiring a replacement costs $30-80
- Frame pauses as "extend your trial" not "take a break"
- Frame skips as "push your next order out so you can finish what you have"
- Lead with empathy about not having had enough time to see results
- Prioritize reviews from people who almost quit early but stayed ("glad I stayed", "took a few months")`
      : "";

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `You are a subscription retention specialist. Based on the customer profile and cancel reason, pick the 3 remedies most likely to convince this customer to stay.

Customer: LTV $${(customer.ltv_cents / 100).toFixed(0)}, retention score ${customer.retention_score}/100, subscribed ${customer.subscription_age_days} days, ${customer.total_orders} orders, products: ${customer.products.join(", ")}${customer.first_renewal ? ", FIRST RENEWAL (never renewed yet)" : ""}
Cancel reason: "${reasonLabels[cancelReason] || cancelReason}"
Available remedies: ${JSON.stringify(remedyList)}
Available coupons: ${JSON.stringify(couponList)}
Product reviews: ${JSON.stringify(reviewList)}${suggestedRemedyId ? `\n\nIMPORTANT: The admin has suggested remedy ID "${suggestedRemedyId}" for this cancel reason. Prioritize including it in your top 3 picks if it's a good fit, but still choose the best overall combination.` : ""}${firstRenewalContext}

IMPORTANT: Never select two remedies of the same type (e.g. don't show two coupons or two pause options). Each remedy must be a different type to give the customer distinct choices.

Return a JSON array of exactly 3 remedies with:
- remedy_id: which remedy to offer
- pitch: 1-2 sentence pitch (casual, empathetic, specific to their situation). Max 25 words.
- coupon_code: if remedy is coupon type, which code to use (or omit)
- confidence: 0-1 how likely to save

Return ONLY the JSON array, no other text.`,
          },
        ],
      }),
    });

    if (!aiRes.ok) throw new Error(`Anthropic API error: ${aiRes.status}`);
    const aiData = await aiRes.json();
    const text = (aiData.content?.[0] as { type: string; text: string })?.text?.trim() || "[]";
    // Parse JSON, handling potential markdown code blocks
    const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    let selections: RemedySelection[] = JSON.parse(jsonStr);

    // Deduplicate by remedy type — keep only the first of each type
    const remedyTypeMap = new Map(remedies.map(r => [r.id, r.type]));
    const seenTypes = new Set<string>();
    selections = selections.filter(s => {
      const rType = remedyTypeMap.get(s.remedy_id);
      if (!rType || seenTypes.has(rType)) return false;
      seenTypes.add(rType);
      return true;
    });

    // Enrich selections with name/description/type from the database
    const remedyMap = new Map(remedies.map(r => [r.id, r]));
    const enriched = selections.slice(0, 3).map(s => {
      const r = remedyMap.get(s.remedy_id);
      return {
        ...s,
        name: r?.name || "",
        description: r?.description || null,
        type: r?.type || "",
      };
    });

    return {
      remedies: enriched,
      review: bestReview
        ? { summary: bestReview.summary, rating: bestReview.rating, body: bestReview.body, reviewer_name: bestReview.reviewer_name }
        : null,
    };
  } catch (err) {
    console.error("AI remedy selection failed:", err);
    // Fallback: return first 3 remedies with generic pitches
    return {
      remedies: remedies
        .slice(0, 3)
        .map(r => ({
          remedy_id: r.id,
          name: r.name,
          description: r.description || null,
          type: r.type,
          pitch: r.description || r.name,
          confidence: 0.5,
        })),
      review: bestReview
        ? { summary: bestReview.summary, rating: bestReview.rating, body: bestReview.body, reviewer_name: bestReview.reviewer_name }
        : null,
    };
  }
}

export async function generateOpenEndedResponse(
  workspaceId: string,
  cancelReason: string,
  customerMessage: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  customer: CustomerContext,
  products: string[],
): Promise<string> {
  const admin = createAdminClient();

  const { data: ws } = await admin.from("workspaces").select("name").eq("id", workspaceId).single();

  // Fetch remedies for context
  const { data: remedies } = await admin
    .from("remedies")
    .select("name, type, description")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .order("priority", { ascending: true });

  const remediesList = (remedies || [])
    .map(r => `- ${r.name}: ${r.description || r.type}`)
    .join("\n");

  // Fetch reviews for the customer's subscription products
  const reviews = await getReviewsForProducts(workspaceId, products);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "I'm sorry, I'm having trouble right now. Let me connect you with a team member who can help.";

  const reasonLabels: Record<string, string> = {
    just_pausing: "Just needs a break",
    something_else: "Something else",
    reached_goals: "Already reached goals",
  };

  const systemPrompt = `You are a friendly subscription specialist for ${ws?.name || "our company"}. A customer wants to cancel their subscription.

Their reason: "${reasonLabels[cancelReason] || cancelReason}"
Their products: ${products.join(", ")}
They've been subscribed for ${customer.subscription_age_days} days with ${customer.total_orders} orders totaling $${(customer.ltv_cents / 100).toFixed(0)}.

Available remedies you can offer:
${remediesList}

Relevant reviews: ${reviews.slice(0, 2).map(r => r.summary).join("; ")}

Be empathetic and genuine. Don't be pushy. Understand their real concern first, then naturally suggest a remedy that fits. Keep responses under 3 sentences. Reference their specific products when relevant.

If they're firm on cancelling after 2-3 exchanges, accept gracefully: "I completely understand. Let me go ahead and cancel that for you."`;

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        ...conversationHistory,
        { role: "user", content: customerMessage },
      ],
    }),
  });

  if (!aiRes.ok) return "I'm sorry, I'm having trouble right now. Let me connect you with a team member.";
  const aiData = await aiRes.json();
  return (aiData.content?.[0] as { type: string; text: string })?.text?.trim() || "I understand. Let me connect you with someone who can help.";
}
