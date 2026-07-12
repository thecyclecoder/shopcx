/**
 * Ad tool — Phase 0.5 angle generator.
 *
 * Consumes ONLY the ShopCX Product Intelligence Engine's structured fields (the
 * tier 1-5 data-source contract) and produces direct-response angles anchored to
 * the PROVEN leading benefits. No free-form markdown ingestion of any kind.
 *
 * See docs/brain/specs/ad-tool.md Phase 0.5 + the data-source contract table.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import {
  HOOK_FORMULAS,
  LIFE_FORCE_8,
  DEFAULT_BANNED_WORDS,
  META_CAPS,
  URGENCY_LEVERS,
  VIBE_TAGS,
  resolveAdToolSettings,
} from "@/lib/ad-tool-config";
import type { AngleGeneratorInput, ProductAdAngle } from "@/lib/ad-types";
import { validateAngle } from "@/lib/ad-validator";
import { isAdvertisedProduct } from "@/lib/advertised-products";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Tier hydration ──────────────────────────────────────────────────────────

/** Hydrate every tier of the data-source contract in one parallelized pass. */
export async function loadAngleInputs(productId: string): Promise<AngleGeneratorInput> {
  const admin = createAdminClient();

  const { data: product } = await admin
    .from("products")
    .select("id, workspace_id, title, target_customer, certifications, allergen_free, awards, physical_dimensions")
    .eq("id", productId)
    .single();
  if (!product) throw new Error("product_not_found");
  const workspaceId = product.workspace_id;

  const [pageRes, benefitsRes, reviewsRes, reviewAggRes, wsRes, variantRes] = await Promise.all([
    // Tier 1 — latest published page content
    admin
      .from("product_page_content")
      .select("hero_headline, hero_subheadline, benefit_bar, guarantee_copy, expectation_timeline, version, status")
      .eq("product_id", productId)
      .eq("status", "published")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Tier 2 — lead, science-confirmed benefits
    admin
      .from("product_benefit_selections")
      .select("benefit_name, customer_phrases, ingredient_research_ids, ai_confidence, role, science_confirmed")
      .eq("product_id", productId)
      .eq("role", "lead")
      .eq("science_confirmed", true),
    // Tier 4 — quotable proof
    admin
      .from("product_reviews")
      .select("rating, body, smart_quote, summary, featured, created_at")
      .eq("product_id", productId)
      .gte("rating", 4)
      .order("featured", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(10),
    // Tier 5 — aggregate review stats (published)
    admin
      .from("product_reviews")
      .select("rating", { count: "exact" })
      .eq("product_id", productId)
      .eq("status", "published"),
    admin.from("workspaces").select("social_brand_proof_points").eq("id", workspaceId).single(),
    // Operator-confirmed isolated image + dimensions (variant override wins)
    admin
      .from("product_variants")
      .select("isolated_image_url, physical_dimensions")
      .eq("product_id", productId)
      .not("isolated_image_url", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);

  // Tier 3 — ingredient science (>=0.6 confidence), joined to ingredient names.
  const { data: research } = await admin
    .from("product_ingredient_research")
    .select("ingredient_id, benefit_headline, clinically_studied_benefits, citations, ai_confidence")
    .eq("product_id", productId)
    .gte("ai_confidence", 0.6);
  const ingredientIds = Array.from(new Set((research || []).map((r) => r.ingredient_id)));
  const ingredientNameById = new Map<string, string>();
  if (ingredientIds.length) {
    const { data: ings } = await admin.from("product_ingredients").select("id, name").in("id", ingredientIds);
    for (const i of ings || []) ingredientNameById.set(i.id, i.name);
  }

  const page = pageRes.data;
  const reviews = reviewsRes.data || [];
  const reviewRows = reviewAggRes.data || [];
  const reviewCount = reviewAggRes.count ?? reviewRows.length;
  const reviewAvg =
    reviewRows.length > 0
      ? Math.round((reviewRows.reduce((a, r) => a + (r.rating || 0), 0) / reviewRows.length) * 10) / 10
      : 0;

  const dims =
    (variantRes.data?.physical_dimensions as AngleGeneratorInput["physical_dimensions"]) ||
    (product.physical_dimensions as AngleGeneratorInput["physical_dimensions"]) ||
    null;

  return {
    product_id: productId,
    product_title: product.title,
    hero_headline: page?.hero_headline || "",
    hero_subheadline: page?.hero_subheadline || "",
    benefit_bar: Array.isArray(page?.benefit_bar) ? (page!.benefit_bar as AngleGeneratorInput["benefit_bar"]) : [],
    guarantee_copy: page?.guarantee_copy || "",
    expectation_timeline: Array.isArray(page?.expectation_timeline)
      ? (page!.expectation_timeline as AngleGeneratorInput["expectation_timeline"])
      : [],
    lead_benefits: (benefitsRes.data || []).map((b) => ({
      name: b.benefit_name,
      customer_phrases: b.customer_phrases || [],
      ingredient_research_ids: b.ingredient_research_ids || [],
      ai_confidence: Number(b.ai_confidence ?? 0),
    })),
    ingredient_science: (research || []).map((r) => ({
      ingredient_name: ingredientNameById.get(r.ingredient_id) || "ingredient",
      benefit_headline: r.benefit_headline,
      clinically_studied_benefits: r.clinically_studied_benefits || [],
      citations: r.citations,
    })),
    proof_quotes: reviews.map((r) => ({ rating: r.rating || 0, quote: r.smart_quote || r.summary || r.body || "" })).filter((q) => q.quote),
    credibility: {
      certifications: product.certifications || [],
      allergen_free: product.allergen_free || [],
      awards: product.awards || [],
      review_count: reviewCount,
      review_avg: reviewAvg,
      clinical_study_count: (research || []).length,
      brand_proof_points: wsRes.data?.social_brand_proof_points || "",
    },
    target_customer: product.target_customer || "",
    physical_dimensions: dims,
    variant_isolated_image_url: variantRes.data?.isolated_image_url || null,
  };
}

// ── Prompt construction ──────────────────────────────────────────────────────

function buildSystemPrompt(bannedWords: string[], lf8Allowed: number[]): string {
  const hooks = HOOK_FORMULAS.map((h) => `- ${h.slug}: "${h.template}" — lever: ${h.lever}; best for LF8 ${h.bestForLf8.join("/")}`).join("\n");
  const lf8 = lf8Allowed.map((n) => `${n}. ${LIFE_FORCE_8[n]}`).join("\n");
  return `You are a direct-response ad strategist for a supplements/superfoods brand. You write SCROLL-STOPPING paid-social ad angles, not "safe" brand ads. Nobody scrolls their feed looking for a product — they scroll looking for something that will fix their life. Every angle obeys that.

THE 12 HOOK FORMULAS (pick one per angle, never improvise a warm intro):
${hooks}

LIFE FORCE 8 SLOTS THIS BRAND MAY TARGET (pick the 1-2 most relevant per angle):
${lf8}

HARD RULES (violating any one makes the angle INVALID):
1. lead_benefit_anchor MUST be copied VERBATIM from one of the provided benefit_bar[].text OR lead_benefits[].name strings. Never invent a benefit.
2. pain_now MUST be drawn from a provided customer_phrases entry or a proof_quote — verbatim or a close paraphrase. Never invent customer pain.
3. proof_anchor.value MUST cite a real ingredient_science benefit_headline, a real proof_quote, an award, or a real credibility stat (e.g. "${"{review_count}"}+ reviews", "{clinical_study_count} clinical studies"). Made-up numbers are forbidden.
4. NEVER use these banned soft words anywhere: ${bannedWords.join(", ")}.
5. hook_one_liner ≤ 15 words. No "Hey", "Hi", "Welcome", "Introducing", or brand-name openers.
6. Meta copy character caps are HARD: meta_headline ≤ ${META_CAPS.headline}, meta_primary_text ≤ ${META_CAPS.primary_text}, meta_description ≤ ${META_CAPS.description}. Count characters; do not exceed.
7. urgency_lever ∈ {${URGENCY_LEVERS.join(", ")}}. vibe_tags ⊆ {${VIBE_TAGS.join(", ")}}.

Generate a SPREAD: for each relevant LF8 slot, 3-4 angles using DIFFERENT hook formulas.

Return ONLY a JSON object: { "angles": [ { hook_slug, lf8_slot, lead_benefit_anchor, pain_now, desired_outcome, hook_one_liner, proof_anchor: { type, value, source_id? }, urgency_lever, enemy, vibe_tags: [...], meta_headline, meta_primary_text, meta_description } ] }. No prose, no markdown fences.`;
}

function buildUserPrompt(inputs: AngleGeneratorInput, count: number): string {
  return `Generate ${count} ad angles for this product. Source data (your ONLY allowed source of claims):\n\n${JSON.stringify(
    {
      product_title: inputs.product_title,
      target_customer: inputs.target_customer,
      tier1_leading_promise: {
        hero_headline: inputs.hero_headline,
        hero_subheadline: inputs.hero_subheadline,
        benefit_bar: inputs.benefit_bar,
        guarantee_copy: inputs.guarantee_copy,
        expectation_timeline: inputs.expectation_timeline,
      },
      tier2_lead_benefits: inputs.lead_benefits,
      tier3_ingredient_science: inputs.ingredient_science,
      tier4_proof_quotes: inputs.proof_quotes,
      tier5_credibility: inputs.credibility,
    },
    null,
    2,
  )}`;
}

function parseAngles(text: string): any[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  let obj: any = null;
  try {
    obj = JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first === -1 || last === -1) return [];
    try {
      obj = JSON.parse(stripped.slice(first, last + 1));
    } catch {
      return [];
    }
  }
  if (Array.isArray(obj)) return obj;
  return Array.isArray(obj?.angles) ? obj.angles : [];
}

function cap(s: unknown, n: number): string {
  return String(s ?? "").slice(0, n);
}

function coerceAngle(raw: any, productId: string): ProductAdAngle {
  return {
    product_id: productId,
    hook_slug: String(raw.hook_slug || "problem_now"),
    lf8_slot: Number(raw.lf8_slot) || 1,
    lead_benefit_anchor: String(raw.lead_benefit_anchor || ""),
    pain_now: String(raw.pain_now || ""),
    desired_outcome: String(raw.desired_outcome || ""),
    hook_one_liner: String(raw.hook_one_liner || ""),
    proof_anchor:
      raw.proof_anchor && typeof raw.proof_anchor === "object"
        ? { type: raw.proof_anchor.type || "stat", value: String(raw.proof_anchor.value || ""), source_id: raw.proof_anchor.source_id }
        : { type: "stat", value: "" },
    urgency_lever: (URGENCY_LEVERS as readonly string[]).includes(raw.urgency_lever) ? raw.urgency_lever : "none",
    enemy: raw.enemy || null,
    vibe_tags: Array.isArray(raw.vibe_tags) ? raw.vibe_tags.filter((v: string) => (VIBE_TAGS as readonly string[]).includes(v)) : [],
    // Defensive truncation — the DB CHECK is a backstop, but we never want to bounce an insert.
    meta_headline: cap(raw.meta_headline, META_CAPS.headline),
    meta_primary_text: cap(raw.meta_primary_text, META_CAPS.primary_text),
    meta_description: cap(raw.meta_description, META_CAPS.description),
    generated_by: "ai",
  };
}

// ── Generation ───────────────────────────────────────────────────────────────

export interface GenerateAnglesResult {
  ok: boolean;
  inserted: ProductAdAngle[];
  rejected: Array<{ angle: ProductAdAngle; reasons: string[] }>;
  reason?: string;
}

/**
 * Generate `count` angles for a product, validate each against the anchoring
 * contract, archive prior active angles, and insert the survivors.
 */
export async function generateAngles(productId: string, count = 12): Promise<GenerateAnglesResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, inserted: [], rejected: [], reason: "no_api_key" };
  const admin = createAdminClient();
  // Hero-product advertising gate ([[advertised-products]]): attachment SKUs never get angles
  // generated — the reason we added the flag (a stray Tumbler/Sleep-Gummies angle would seed
  // Dahlia's cadence downstream via product_ad_angles). Gate BEFORE the metered Opus call so
  // an attachment call costs 0 tokens, not the ~8k of a full angle-gen turn.
  if (!(await isAdvertisedProduct(admin, productId))) {
    return { ok: false, inserted: [], rejected: [], reason: "not_advertised" };
  }
  const inputs = await loadAngleInputs(productId);

  const { data: product } = await admin.from("products").select("workspace_id").eq("id", productId).single();
  const workspaceId = product?.workspace_id as string;
  const { data: ws } = await admin.from("workspaces").select("ad_tool_settings").eq("id", workspaceId).single();
  const settings = resolveAdToolSettings(ws?.ad_tool_settings);
  const bannedWords = settings.banned_words?.length ? settings.banned_words : DEFAULT_BANNED_WORDS;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 8000,
      system: buildSystemPrompt(bannedWords, settings.lf8_allowed),
      messages: [{ role: "user", content: buildUserPrompt(inputs, count) }],
    }),
  });
  if (!res.ok) return { ok: false, inserted: [], rejected: [], reason: `opus_${res.status}` };
  const json = await res.json();
  const text = (json?.content?.[0]?.text || "").trim();
  if (json?.usage) {
    try {
      await logAiUsage({ workspaceId, model: OPUS_MODEL, usage: json.usage, purpose: "ad_angle_generation", ticketId: null });
    } catch {}
  }

  const rawAngles = parseAngles(text);
  const inserted: ProductAdAngle[] = [];
  const rejected: GenerateAnglesResult["rejected"] = [];
  const rows: any[] = [];

  for (const raw of rawAngles) {
    const angle = coerceAngle(raw, productId);
    const v = validateAngle(angle, inputs);
    // Banned-word check on the angle's own copy.
    const blob = `${angle.hook_one_liner} ${angle.desired_outcome} ${angle.meta_headline} ${angle.meta_primary_text}`.toLowerCase();
    const bannedHit = bannedWords.find((w) => new RegExp(`\\b${w.toLowerCase()}\\b`).test(blob));
    if (!v.ok || bannedHit) {
      rejected.push({ angle, reasons: [...v.violations.map((x) => x.message), ...(bannedHit ? [`banned word "${bannedHit}"`] : [])] });
      continue;
    }
    inserted.push(angle);
    rows.push({
      workspace_id: workspaceId,
      product_id: productId,
      hook_slug: angle.hook_slug,
      lf8_slot: angle.lf8_slot,
      lead_benefit_anchor: angle.lead_benefit_anchor,
      pain_now: angle.pain_now,
      desired_outcome: angle.desired_outcome,
      hook_one_liner: angle.hook_one_liner,
      proof_anchor: angle.proof_anchor,
      urgency_lever: angle.urgency_lever,
      enemy: angle.enemy,
      vibe_tags: angle.vibe_tags,
      meta_headline: angle.meta_headline,
      meta_primary_text: angle.meta_primary_text,
      meta_description: angle.meta_description,
      generated_by: "ai",
    });
  }

  if (rows.length) {
    // Re-run semantics: archive prior active angles, then append the fresh set.
    await admin.from("product_ad_angles").update({ is_active: false }).eq("product_id", productId).eq("is_active", true);
    const { error } = await admin.from("product_ad_angles").insert(rows);
    if (error) return { ok: false, inserted: [], rejected, reason: error.message };
  }

  return { ok: true, inserted, rejected };
}
