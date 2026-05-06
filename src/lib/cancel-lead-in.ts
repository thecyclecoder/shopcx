/**
 * Opus-generated lead-in for the cancel-flow remedies step.
 *
 * Used by both:
 *  - Journey mini-site: /api/journey/[token]/remedies
 *  - Portal API handler: src/lib/portal/handlers/cancel-journey.ts
 *
 * Three pillars: acknowledge, appreciate, save. Always pivots toward a
 * save-rebuttal that flips the customer's reason into a reason to stay.
 *
 * Returns null on any failure — caller falls back to a generic line.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface CancelLeadInArgs {
  workspaceId: string;
  customerId: string;
  reasonLabel: string;
  ageMonths: number;
  products: string[];
}

export async function generateCancelLeadIn(args: CancelLeadInArgs): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("first_name, first_order_at, total_orders")
    .eq("id", args.customerId)
    .single();
  const firstName = customer?.first_name || "there";

  // Customer tenure (months as a customer) is often more meaningful than the
  // current subscription's age — long-time customers who re-subscribed after
  // a pause have a 1-month sub but years of relationship. Pass both signals
  // and let Opus use the more meaningful one.
  const customerMonths = customer?.first_order_at
    ? Math.floor((Date.now() - new Date(customer.first_order_at).getTime()) / (1000 * 60 * 60 * 24 * 30))
    : 0;
  const totalOrders = customer?.total_orders ?? 0;

  const subTenureLine = args.ageMonths >= 1
    ? `${args.ageMonths} month${args.ageMonths === 1 ? "" : "s"}`
    : "less than 30 days";
  const customerTenureLine = customerMonths >= 1
    ? `${customerMonths} month${customerMonths === 1 ? "" : "s"} (${totalOrders} total orders)`
    : "less than 30 days as a customer";

  const productLine = args.products.length ? args.products.join(", ") : "their subscription";

  const prompt = `Write a 1-2 sentence lead-in for a cancel-flow page. We are always working on the save. Three pillars (compress all three into 1-2 sentences):

  1. ACKNOWLEDGE — name their reason in their own framing, briefly
  2. APPRECIATE — when meaningful, reference their tenure (1+ months) as something you genuinely value
  3. SAVE — pivot to a soft rebuttal that flips the reason into a reason to stay

Customer: ${firstName}
Reason: "${args.reasonLabel}"
Current subscription age: ${subTenureLine}
Customer relationship age: ${customerTenureLine}
Product(s): ${productLine}

TENURE GUIDANCE: Use the SHORTER tenure value only when it accurately reflects the customer's experience with the product. For long-time customers on a newer subscription (e.g. customer relationship: 24 months, current sub: 1 month — they likely re-subscribed after a pause), reference the LONGER customer relationship age — that's what feels accurate. Don't say "in just a month" to someone who's been with us for years.

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
        // Opus — first save touch, strongest reasoning over reason × tenure × product.
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
