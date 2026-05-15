/**
 * Regenerate a SINGLE page_content field for a product without
 * touching anything else (notably: leave hero_headline,
 * hero_subheadline, and benefit_bar alone). Updates the LATEST
 * row in place — doesn't create a new version, because this is a
 * scoped editorial regen, not a fresh content cycle.
 *
 * Initial supported field: `mechanism_copy`.
 *
 * Body: { field: "mechanism_copy" }
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SONNET_MODEL } from "@/lib/ai-models";

const SONNET = SONNET_MODEL;
const SUPPORTED_FIELDS = new Set<string>(["mechanism_copy"]);

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
  const field = String(body?.field || "");
  if (!SUPPORTED_FIELDS.has(field)) {
    return NextResponse.json({ error: `Unsupported field "${field}". Supported: ${[...SUPPORTED_FIELDS].join(", ")}` }, { status: 400 });
  }

  // Latest content row — we'll PATCH it in place.
  const { data: latestContent } = await admin
    .from("product_page_content")
    .select("id, benefit_bar")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("version", { ascending: false })
    .limit(1).maybeSingle();
  if (!latestContent) {
    return NextResponse.json({ error: "No page content exists yet — run a full generation first." }, { status: 400 });
  }

  const [{ data: product }, { data: ingredients }, { data: research }, { data: reviewAnalysis }] = await Promise.all([
    admin.from("products").select("id, title, target_customer, certifications").eq("id", productId).single(),
    admin.from("product_ingredients").select("id, name, dosage_display, display_order").eq("workspace_id", workspaceId).eq("product_id", productId).order("display_order"),
    admin.from("product_ingredient_research").select("id, ingredient_id, benefit_headline, mechanism_explanation, ai_confidence").eq("workspace_id", workspaceId).eq("product_id", productId),
    admin.from("product_review_analysis").select("top_benefits, most_powerful_phrases").eq("workspace_id", workspaceId).eq("product_id", productId).maybeSingle(),
  ]);

  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  const benefitBar = (latestContent.benefit_bar as Array<{ text: string; icon_hint?: string }>) || [];
  if (benefitBar.length === 0) {
    return NextResponse.json({ error: "benefit_bar is empty on the latest page_content — generate or fill that first." }, { status: 400 });
  }

  // Field-specific prompt
  if (field === "mechanism_copy") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });

    const system = `You are a conversion-focused DTC copywriter writing the "Why this works" section that appears immediately below the hero. Your job is to make the customer believe the hero's benefit chips are real — by explaining (briefly, in plain outcome language) how the formulation produces each one.

READING LEVEL: 8th grade. Target Flesch-Kincaid grade ≤ 8. Our core
customer is 45-64. They want to understand without effort.

RULES:
- Open with one connective sentence that bridges from the benefits.
- Then address EVERY benefit chip in the same order as listed.
- Short sentences. 12-15 words max. One idea per sentence.
- Use everyday words. Say "calms the brain" not "reduces neuroinflammation";
  "burns fat" not "boosts fat oxidation"; "keeps blood sugar steady" not
  "modulates glucose absorption"; "feels smooth" not "without jitters or
  vasoconstriction."
- Never use: blood-brain barrier, chlorogenic acids, cardiovascular,
  glucose absorption, neuroinflammation, vasodilation, bioavailability,
  antioxidant-rich, modulates, upregulates, mechanism, pathway. If a
  term needs jargon, find another way to say it.
- No semicolons. No "while X, Y" pairs.
- Ingredients OK to name, but tie each to a plain-language effect.
- Never introduce science unrelated to the listed benefits.
- Never invent customer quotes.
- 4-6 short sentences total.
- Respond with strict JSON only: { "mechanism_copy": "string" }`;

    const userPrompt = `Generate mechanism_copy for this product.

PRODUCT
Title: ${product.title}
Target customer: ${product.target_customer || "general adult"}
Certifications: ${(product.certifications || []).join(", ") || "none"}

BENEFIT CHIPS (the hero shows these — your copy must deliver on each, in this order):
${benefitBar.map((b, i) => `${i + 1}. ${b.text}`).join("\n")}

INGREDIENTS & RESEARCH:
${JSON.stringify(
  (ingredients || []).map((i) => ({
    name: i.name,
    dosage: i.dosage_display,
    research: (research || [])
      .filter((r) => r.ingredient_id === i.id)
      .map((r) => ({ benefit: r.benefit_headline, mechanism: r.mechanism_explanation, confidence: r.ai_confidence })),
  })),
)}

REVIEW VOICE:
${JSON.stringify(reviewAnalysis || {})}

Return the JSON object only.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SONNET,
        max_tokens: 2048,
        temperature: 0.2,
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
      ?.map((b) => (b.type === "text" ? b.text || "" : "")).join("").trim() || "";
    // Parse JSON
    let parsed: { mechanism_copy?: string } | null = null;
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
    const newCopy = (parsed?.mechanism_copy || "").trim();
    if (!newCopy) {
      return NextResponse.json({ error: "AI returned no mechanism_copy", raw: text.slice(0, 500) }, { status: 502 });
    }

    const { error: updateErr } = await admin
      .from("product_page_content")
      .update({ mechanism_copy: newCopy, updated_at: new Date().toISOString() })
      .eq("id", latestContent.id);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Revalidate the public PDP so the new copy shows immediately.
    try {
      const { revalidatePath } = await import("next/cache");
      const { data: productRow } = await admin.from("products").select("handle").eq("id", productId).single();
      const { data: ws } = await admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single();
      if (productRow?.handle) {
        if (ws?.storefront_slug) revalidatePath(`/store/${ws.storefront_slug}/${productRow.handle}`);
        revalidatePath(`/${productRow.handle}`);
      }
    } catch { /* non-fatal */ }

    return NextResponse.json({ field, value: newCopy });
  }

  return NextResponse.json({ error: "Unreachable" }, { status: 500 });
}
