import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectRemedies, isConcreteReason } from "@/lib/remedy-selector";

/**
 * Generate a contextual 1-2 sentence lead-in for the remedies step.
 * Tailors the message to the customer's specific cancel reason + tenure
 * so we don't say "best results with 3 months" to someone who's been
 * around 6 months and cancelled because they reached their goals.
 *
 * Returns null on any failure — caller should fall back to a generic
 * static line.
 */
async function generateRemedyLeadIn(args: {
  workspaceId: string;
  customerId: string;
  reasonLabel: string;
  ageMonths: number;
  products: string[];
}): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("first_name")
    .eq("id", args.customerId)
    .single();
  const firstName = customer?.first_name || "there";

  const tenureLine = args.ageMonths >= 1
    ? `${args.ageMonths} month${args.ageMonths === 1 ? "" : "s"} of subscription tenure`
    : "first month with us (less than 30 days)";

  const productLine = args.products.length ? args.products.join(", ") : "their subscription";

  const prompt = `Write a 1-2 sentence lead-in for a cancel-flow page. We are always working on the save. Three pillars (compress all three into 1-2 sentences):

  1. ACKNOWLEDGE — name their reason in their own framing, briefly
  2. APPRECIATE — when meaningful, reference their tenure (1+ months) as something you genuinely value
  3. SAVE — pivot to a soft rebuttal that flips the reason into a reason to stay

Customer: ${firstName}
Reason: "${args.reasonLabel}"
Tenure: ${tenureLine}
Product(s): ${productLine}

Save-pivots by reason (study, don't copy):
  • "Already reached my goals" → time to MAINTAIN those results, not lose them
  • "Too expensive" → discount so you can continue your progress
  • "Too much product" → a pause lets you work through what you have without losing your locked-in price
  • "Not seeing results" → most people see best results with consistent use over 3 months
  • "Just need a break" → pause keeps your spot + your price
  • "Tired of the flavor" → swap to a different flavor and keep going
  • "Shipping issues" → let's make it right with a replacement

Output: 1-2 sentences, plain text only, no quotes/markdown/emoji. End with a short bridge ("here's what we can do" / "here are some options") if it fits naturally.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Opus for the lead-in — this is the customer's first save touch
        // and warrants the strongest reasoning over reason × tenure × product.
        model: "claude-opus-4-7",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content?.[0] as { text?: string })?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * POST: Get AI-selected remedies for a cancel journey.
 * Called after customer selects their cancel reason.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, config_snapshot, status")
    .eq("token", token)
    .single();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (session.status === "completed") return NextResponse.json({ error: "already_completed" }, { status: 400 });

  const body = await request.json();
  const { cancel_reason, cancel_reason_label, subscription_id } = body as { cancel_reason: string; cancel_reason_label?: string; subscription_id?: string };

  if (!cancel_reason) return NextResponse.json({ error: "cancel_reason required" }, { status: 400 });

  const config = session.config_snapshot as { metadata?: { subscriptions?: { id: string; contractId: string; items: { title: string }[]; isFirstRenewal?: boolean; subscriptionAgeDays?: number }[] } };
  const metadata = config.metadata || {};

  // Get subscription's product IDs for review matching
  const selectedSub = subscription_id
    ? (metadata.subscriptions || []).find(s => s.id === subscription_id)
    : (metadata.subscriptions || [])[0];

  // Get customer context
  const { data: customer } = await admin
    .from("customers")
    .select("id, retention_score, shopify_customer_id")
    .eq("id", session.customer_id)
    .single();

  const { getCustomerStats } = await import("@/lib/customer-stats");
  const stats = await getCustomerStats(session.customer_id);
  const totalOrders = stats.total_orders;
  const ltv = stats.ltv_cents;

  // Calculate subscription age
  const { data: sub } = subscription_id
    ? await admin.from("subscriptions").select("created_at").eq("id", subscription_id).single()
    : { data: null };
  const subAge = sub?.created_at
    ? Math.floor((Date.now() - new Date(sub.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const products = selectedSub?.items?.map(i => i.title) || [];

  // Get product Shopify IDs for review matching
  const { data: productRecords } = await admin
    .from("products")
    .select("shopify_product_id, title")
    .eq("workspace_id", session.workspace_id);

  const matchingProductIds = (productRecords || [])
    .filter(p => products.some(name => p.title?.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(p.title?.toLowerCase() || "")))
    .map(p => p.shopify_product_id);

  const concrete = isConcreteReason(cancel_reason);

  const isFirstRenewal = selectedSub?.isFirstRenewal || false;

  // Check grandfathered pricing
  let isGrandfathered = false;
  if (subscription_id) {
    const { data: subItems } = await admin.from("subscriptions").select("items").eq("id", subscription_id).single();
    const { data: prods } = await admin.from("products").select("variants").eq("workspace_id", session.workspace_id);
    const pMap = new Map<string, number>();
    for (const p of prods || []) for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) if (v.id && v.price_cents) pMap.set(String(v.id), v.price_cents);
    for (const item of (subItems?.items as { variant_id?: string; price_cents?: number }[]) || []) {
      if (!item.price_cents || !item.variant_id) continue;
      const std = pMap.get(String(item.variant_id));
      if (std && Math.round(item.price_cents / 0.75) < std) { isGrandfathered = true; break; }
    }
  }

  if (concrete) {
    const { remedies, review } = await selectRemedies(
      session.workspace_id,
      cancel_reason,
      {
        ltv_cents: ltv,
        retention_score: customer?.retention_score || 50,
        subscription_age_days: subAge,
        total_orders: totalOrders,
        products,
        first_renewal: isFirstRenewal,
        isGrandfathered,
      },
      matchingProductIds,
    );

    const lead_in = await generateRemedyLeadIn({
      workspaceId: session.workspace_id,
      customerId: session.customer_id,
      reasonLabel: cancel_reason_label || cancel_reason,
      ageMonths: Math.floor(subAge / 30),
      products,
    });

    return NextResponse.json({
      type: "remedies",
      remedies,
      review,
      lead_in,
    });
  }

  // Open-ended reason — return signal to start AI chat
  return NextResponse.json({
    type: "ai_chat",
    initial_message: null, // Client will call /chat endpoint for messages
  });
}
