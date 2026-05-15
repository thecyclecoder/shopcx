/**
 * Generate AI complementarity copy for a product's upsell pairing.
 * Reads both products' ingredient + benefit data and returns a short
 * "why these two complement each other" payload the admin can edit
 * before saving:
 *
 *   { headline, intro, bullets[] }
 *
 * Body: { partner_product_id?: string }
 *   - Defaults to the primary's products.upsell_product_id if not provided.
 *
 * Output is returned only; persistence happens through the existing
 * PATCH /api/workspaces/[id]/products/[productId] endpoint when the
 * admin clicks Save.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { HAIKU_MODEL } from "@/lib/ai-models";

const HAIKU = HAIKU_MODEL;

type IngredientRow = { id: string; name: string; dosage_display: string | null };
type ResearchRow = { ingredient_id: string; benefit_headline: string | null; mechanism_explanation: string | null };

async function loadProductBundle(admin: ReturnType<typeof createAdminClient>, workspaceId: string, productId: string) {
  const [{ data: product }, { data: ingredients }, { data: research }, { data: content }] = await Promise.all([
    admin.from("products").select("id, title, target_customer, certifications").eq("id", productId).eq("workspace_id", workspaceId).single(),
    admin.from("product_ingredients").select("id, name, dosage_display, display_order").eq("workspace_id", workspaceId).eq("product_id", productId).order("display_order"),
    admin.from("product_ingredient_research").select("ingredient_id, benefit_headline, mechanism_explanation").eq("workspace_id", workspaceId).eq("product_id", productId),
    admin.from("product_page_content").select("benefit_bar, mechanism_copy").eq("workspace_id", workspaceId).eq("product_id", productId).order("version", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { product, ingredients: (ingredients || []) as IngredientRow[], research: (research || []) as ResearchRow[], content };
}

function formatProductForPrompt(label: string, bundle: Awaited<ReturnType<typeof loadProductBundle>>) {
  const { product, ingredients, research, content } = bundle;
  if (!product) return null;
  const benefits = ((content?.benefit_bar as Array<{ text: string }> | null) || []).map(b => b.text);
  return {
    label,
    title: product.title,
    target_customer: product.target_customer || "general adult",
    benefits,
    ingredients: ingredients.map(i => ({
      name: i.name,
      dosage: i.dosage_display,
      research: research
        .filter(r => r.ingredient_id === i.id)
        .map(r => ({ benefit: r.benefit_headline, mechanism: r.mechanism_explanation })),
    })),
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  let partnerId = String(body?.partner_product_id || "").trim();
  if (!partnerId) {
    const { data: primaryRow } = await admin.from("products")
      .select("upsell_product_id").eq("id", productId).eq("workspace_id", workspaceId).single();
    partnerId = primaryRow?.upsell_product_id || "";
  }
  if (!partnerId) {
    return NextResponse.json({ error: "No partner product selected — pick an upsell product first or pass partner_product_id." }, { status: 400 });
  }
  if (partnerId === productId) {
    return NextResponse.json({ error: "Partner product cannot be the same as the primary product." }, { status: 400 });
  }

  const [primary, partner] = await Promise.all([
    loadProductBundle(admin, workspaceId, productId),
    loadProductBundle(admin, workspaceId, partnerId),
  ]);
  if (!primary.product) return NextResponse.json({ error: "Primary product not found" }, { status: 404 });
  if (!partner.product) return NextResponse.json({ error: "Partner product not found" }, { status: 404 });

  const primaryPayload = formatProductForPrompt("primary", primary);
  const partnerPayload = formatProductForPrompt("partner", partner);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

  const system = `You are a DTC copywriter writing the "Better Together" complementarity copy that appears on a product page when the brand is pre-selling a second product as a bundle. Your single job: explain (in plain, concrete language) HOW the partner product's ingredients enhance the primary product's benefits — not a generic "they go well together" pitch.

READING LEVEL: 8th grade. Our core customer is 45-64.

RULES:
- The intro must name a specific way the partner's ingredients change, extend, or amplify what the primary already does. Concrete > generic.
- Bullets are short (8-14 words each), action/effect oriented. Each bullet pairs a partner ingredient or property with a benefit it adds.
- No marketing fluff. No "perfect pairing," "the dynamic duo," "your morning ritual just got better." Earn the recommendation with mechanism, not vibes.
- Never invent ingredients or research that aren't in the data.
- If a partner ingredient is in the data without a known mechanism, you may state the outcome plainly but not invent a science claim.
- Headline: 2-4 words, plain, no emojis.
- Intro: one paragraph, 30-50 words.
- 3 bullets, each a complete sentence ending in a period.

Respond with strict JSON only:
{ "headline": "string", "intro": "string", "bullets": ["string", "string", "string"] }`;

  const userPrompt = `Generate complementarity copy. The customer is shopping the PRIMARY product. We want to convince them to add the PARTNER as a bundle by showing how the partner enhances the primary.

PRIMARY:
${JSON.stringify(primaryPayload, null, 2)}

PARTNER (the upsell):
${JSON.stringify(partnerPayload, null, 2)}

Return only the JSON object.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HAIKU,
      max_tokens: 1024,
      temperature: 0.3,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({ error: `Anthropic error: ${res.status} ${text}` }, { status: 502 });
  }
  const data = await res.json();
  const text = (data.content as Array<{ type: string; text?: string }>)
    ?.map(b => (b.type === "text" ? b.text || "" : "")).join("").trim() || "";

  let parsed: { headline?: string; intro?: string; bullets?: string[] } | null = null;
  try {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const cleaned = (fenceMatch ? fenceMatch[1] : text).trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try { parsed = JSON.parse(text.slice(first, last + 1)); } catch { parsed = null; }
    }
  }
  const headline = (parsed?.headline || "").trim();
  const intro = (parsed?.intro || "").trim();
  const bullets = (parsed?.bullets || []).map(b => String(b || "").trim()).filter(Boolean);
  if (!headline || !intro || bullets.length === 0) {
    return NextResponse.json({ error: "AI returned incomplete payload", raw: text.slice(0, 500) }, { status: 502 });
  }

  return NextResponse.json({ headline, intro, bullets, partner_product_id: partnerId });
}
