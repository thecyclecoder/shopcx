/**
 * Product Intelligence Engine — the Inngest/UI API path.
 *
 * These bodies (ingredient research, review analysis, content generation) back
 * the UI/Inngest Engine (`src/lib/inngest/product-intelligence.ts`), which wraps
 * each call in an Inngest `step.run` for durability/resumability. All Claude
 * calls here go through the Anthropic Messages API with
 * `process.env.ANTHROPIC_API_KEY` — this is the API path.
 *
 * 🚨 The BOX product-seed path is SEPARATE and does NOT use this file. It runs a
 * top-level `claude -p` on Max (the `seed-product` skill) with web search — no
 * Anthropic API, no per-token spend — driving the deterministic tools in
 * `src/lib/product-intelligence/seed-tools.ts`. See docs/brain/specs/box-product-seeding.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { SONNET_MODEL } from "@/lib/ai-models";

type Admin = ReturnType<typeof createAdminClient>;

export const SONNET = SONNET_MODEL;

type AnthropicContentBlock = { type: string; text?: string };

export async function callSonnet(
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; raw: unknown } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
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
        model: SONNET,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [{ role: "user", content: user }],
      }),
      // Bound the call well below the /api/inngest 800s Lambda cap so a stalled
      // Sonnet completion aborts as a normal fetch error (Inngest retries it)
      // instead of being reaped by Vercel as a Lambda timeout.
      signal: AbortSignal.timeout(600_000),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error("Anthropic call timed out after 600s");
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Anthropic error: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  const text =
    (data.content as AnthropicContentBlock[])
      ?.map((b) => (b.type === "text" ? b.text || "" : ""))
      .join("")
      .trim() || "";
  return { text, raw: data };
}

export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const firstBracket = cleaned.indexOf("[");
    let start = -1;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);
    if (start === -1) return null;
    const lastBrace = cleaned.lastIndexOf("}");
    const lastBracket = cleaned.lastIndexOf("]");
    const end = Math.max(lastBrace, lastBracket);
    if (end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Ingredient research
// ============================================================================

export type IngredientBenefit = {
  benefit_headline: string;
  mechanism_explanation: string;
  clinically_studied_benefits?: string[];
  dosage_comparison?: string;
  citations?: Array<{
    title?: string;
    authors?: string;
    journal?: string;
    year?: number | string;
    doi?: string;
    url?: string;
  }>;
  contraindications?: string;
  ai_confidence?: number;
};

export type IngredientLite = {
  id: string;
  name: string;
  dosage_mg: number | null;
  dosage_display: string | null;
  display_order?: number;
};

/**
 * Research ONE ingredient and persist its benefit rows. Fault-isolated by the
 * caller (a slow/failed call must not abort the others). Body is verbatim the
 * old Inngest `step.run("research-${ing.id}")` block.
 */
export async function researchOneIngredient(
  admin: Admin,
  args: { workspace_id: string; product_id: string; ing: IngredientLite; targetCustomer: string },
): Promise<void> {
  const { workspace_id, product_id, ing, targetCustomer } = args;
  const system = `You are a nutritional science researcher. Respond with strict JSON only — no prose, no markdown fences.`;
  const hasDosage = !!(ing.dosage_display || ing.dosage_mg);
  const dosageInstruction = hasDosage
    ? `at a dosage of ${ing.dosage_display || ing.dosage_mg + "mg"}`
    : "(dosage not specified — focus on the ingredient's general benefits, skip dosage comparison)";
  const user = `Research the ingredient "${ing.name}" ${dosageInstruction}.

Target customer profile: ${targetCustomer}

For this ingredient, provide each clinically studied benefit as a separate object with these fields:
- benefit_headline (e.g. "Supports Joint Flexibility")
- mechanism_explanation (2-3 sentences)
- clinically_studied_benefits (array of related endpoints studied)
- dosage_comparison (${hasDosage ? "how the product dosage compares to studied ranges" : "null — dosage not provided"})
- citations (array of {title, authors, journal, year, doi, url})
- contraindications (string, for ${targetCustomer})
- ai_confidence (number 0-1):
  1.0 = multiple RCTs, 0.8 = single RCT, 0.7 = meta-analysis observational,
  0.5 = observational only, 0.3 = traditional use, 0.1 = theoretical

${!hasDosage ? "Since no dosage is specified, set dosage_comparison to null and do not lower confidence scores due to missing dosage info." : ""}
Be conservative with confidence scores. Return a JSON array of benefit objects (no wrapper object).`;

  const result = await callSonnet(system, user, 4096, 0);
  if (!result) return;

  const parsed = extractJson<IngredientBenefit[] | { benefits: IngredientBenefit[] }>(result.text);
  const benefits: IngredientBenefit[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "benefits" in parsed && Array.isArray(parsed.benefits)
      ? parsed.benefits
      : [];

  if (benefits.length === 0) return;

  // Remove existing rows for this ingredient so re-research replaces cleanly
  await admin
    .from("product_ingredient_research")
    .delete()
    .eq("workspace_id", workspace_id)
    .eq("ingredient_id", ing.id);

  const rows = benefits
    .filter((b) => b && typeof b.benefit_headline === "string" && b.benefit_headline.trim())
    .map((b) => ({
      workspace_id,
      product_id,
      ingredient_id: ing.id,
      benefit_headline: b.benefit_headline.trim(),
      mechanism_explanation: b.mechanism_explanation || "",
      clinically_studied_benefits: Array.isArray(b.clinically_studied_benefits)
        ? b.clinically_studied_benefits
        : [],
      dosage_comparison: b.dosage_comparison || null,
      citations: Array.isArray(b.citations) ? b.citations : [],
      contraindications: b.contraindications || null,
      ai_confidence:
        typeof b.ai_confidence === "number" ? Math.max(0, Math.min(1, b.ai_confidence)) : 0.5,
      raw_ai_response: result.raw as Record<string, unknown>,
    }));

  if (rows.length > 0) {
    await admin.from("product_ingredient_research").insert(rows);
  }
}

// ============================================================================
// Review analysis (map-reduce)
// ============================================================================

export type ReviewAnalysisResult = {
  top_benefits?: Array<{
    benefit: string;
    frequency: number;
    customer_phrases?: string[];
    review_ids?: string[];
  }>;
  before_after_pain_points?: Array<{ before: string; after: string; review_ids?: string[] }>;
  skeptic_conversions?: Array<{ summary: string; quote: string; review_id?: string; reviewer_name?: string }>;
  surprise_benefits?: Array<{ benefit: string; quote: string; review_id?: string }>;
  most_powerful_phrases?: Array<{ phrase: string; context?: string; review_id?: string; reviewer_name?: string }>;
};

export type ReviewLite = {
  id: string;
  reviewer_name: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
};

export const REVIEW_CHUNK = 100;

/** Fetch the best product-specific reviews (4★+, non-empty, featured-weighted, longest first). */
export async function fetchReviewsForAnalysis(
  admin: Admin,
  workspace_id: string,
  product_id: string,
): Promise<ReviewLite[]> {
  const { data } = await admin
    .from("product_reviews")
    .select("id, reviewer_name, rating, title, body")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .in("status", ["published", "featured"])
    .gte("rating", 4)
    .not("body", "is", null)
    .order("rating", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  return ((data || []) as ReviewLite[])
    .filter((r) => (r.body || "").trim().length > 0)
    .sort((a, b) => (b.body || "").length - (a.body || "").length);
}

/** Map: analyze a single chunk of reviews → its own structured partial. */
export async function analyzeReviewChunk(chunk: ReviewLite[]): Promise<ReviewAnalysisResult> {
  const reviewsJson = chunk.map((r) => ({
    id: r.id,
    reviewer_name: r.reviewer_name || "Anonymous",
    rating: r.rating,
    title: r.title || "",
    body: r.body,
  }));
  const system = `You are a copywriting-focused review analyst. Every quote you return MUST be an EXACT substring from the review body. Every review_id MUST match one from the input. Respond with strict JSON only — no prose, no markdown fences.`;
  const user = `Analyze these ${chunk.length} product reviews and return a single JSON object with these keys:
- top_benefits: [{ benefit, frequency, customer_phrases: string[], review_ids: string[] }]
- before_after_pain_points: [{ before, after, review_ids: string[] }]
- skeptic_conversions: [{ summary, quote, review_id, reviewer_name }]
- surprise_benefits: [{ benefit, quote, review_id }]
- most_powerful_phrases: [{ phrase, context, review_id, reviewer_name }]

Every quote must be an EXACT substring from a review body. Every review_id must appear in the input.

Reviews:
${JSON.stringify(reviewsJson)}`;
  const resp = await callSonnet(system, user, 8192, 0);
  return (resp ? extractJson<ReviewAnalysisResult>(resp.text) : null) || {};
}

export type ReducedReviewAnalysis = {
  top_benefits: Array<{ benefit: string; frequency: number; customer_phrases: string[]; review_ids: string[] }>;
  before_after_pain_points: Array<{ before: string; after: string; review_ids: string[] }>;
  skeptic_conversions: ReviewAnalysisResult["skeptic_conversions"];
  surprise_benefits: ReviewAnalysisResult["surprise_benefits"];
  most_powerful_phrases: ReviewAnalysisResult["most_powerful_phrases"];
};

/** Reduce: merge per-chunk partials; validate every quote/id against the full review set. */
export function reduceReviewAnalysis(
  reviews: ReviewLite[],
  partials: ReviewAnalysisResult[],
): ReducedReviewAnalysis {
  const validIds = new Set(reviews.map((r) => r.id));
  const bodyById = new Map(reviews.map((r) => [r.id, r.body || ""]));
  const filterReviewIds = (ids: unknown): string[] =>
    Array.isArray(ids) ? (ids.filter((id) => typeof id === "string" && validIds.has(id)) as string[]) : [];
  const validateQuote = (review_id: string | undefined, quote: string | undefined): boolean => {
    if (!review_id || !quote || !validIds.has(review_id)) return false;
    return (bodyById.get(review_id) || "").includes(quote);
  };

  const benefitMap = new Map<string, { benefit: string; frequency: number; customer_phrases: string[]; review_ids: string[] }>();
  for (const p of partials)
    for (const b of p.top_benefits || []) {
      if (!b?.benefit) continue;
      const key = b.benefit.trim().toLowerCase();
      const cur = benefitMap.get(key) || { benefit: b.benefit.trim(), frequency: 0, customer_phrases: [], review_ids: [] };
      cur.frequency += Number(b.frequency) || 0;
      cur.customer_phrases.push(...(Array.isArray(b.customer_phrases) ? b.customer_phrases : []));
      cur.review_ids.push(...filterReviewIds(b.review_ids));
      benefitMap.set(key, cur);
    }
  const top_benefits = [...benefitMap.values()]
    .map((b) => ({
      benefit: b.benefit,
      frequency: b.frequency,
      customer_phrases: [...new Set(b.customer_phrases)].slice(0, 10),
      review_ids: [...new Set(b.review_ids)],
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 10);

  const before_after_pain_points = partials
    .flatMap((p) => (p.before_after_pain_points || []).map((b) => ({ before: b.before, after: b.after, review_ids: filterReviewIds(b.review_ids) })))
    .slice(0, 15);
  const skeptic_conversions = partials.flatMap((p) => (p.skeptic_conversions || []).filter((s) => validateQuote(s.review_id, s.quote))).slice(0, 8);
  const surprise_benefits = partials.flatMap((p) => (p.surprise_benefits || []).filter((s) => validateQuote(s.review_id, s.quote))).slice(0, 12);
  const most_powerful_phrases = partials.flatMap((p) => (p.most_powerful_phrases || []).filter((pp) => validateQuote(pp.review_id, pp.phrase))).slice(0, 20);

  return { top_benefits, before_after_pain_points, skeptic_conversions, surprise_benefits, most_powerful_phrases };
}

/** Upsert the reduced analysis (or the empty shape when there are no reviews). */
export async function persistReviewAnalysis(
  admin: Admin,
  workspace_id: string,
  product_id: string,
  reduced: ReducedReviewAnalysis | null,
  reviewsAnalyzed: number,
  chunks: number,
): Promise<void> {
  await admin.from("product_review_analysis").upsert(
    {
      workspace_id,
      product_id,
      top_benefits: reduced?.top_benefits || [],
      before_after_pain_points: reduced?.before_after_pain_points || [],
      skeptic_conversions: reduced?.skeptic_conversions || [],
      surprise_benefits: reduced?.surprise_benefits || [],
      most_powerful_phrases: reduced?.most_powerful_phrases || [],
      reviews_analyzed_count: reviewsAnalyzed,
      raw_ai_response: { map_reduce: true, chunks, reviews_analyzed: reviewsAnalyzed } as Record<string, unknown>,
      analyzed_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,product_id" },
  );
}

/** Full review analysis to completion (box path): fetch → map chunks → reduce → persist. */
export async function analyzeReviewsCore(
  admin: Admin,
  args: { workspace_id: string; product_id: string },
): Promise<{ analyzed: number }> {
  const { workspace_id, product_id } = args;
  const reviews = await fetchReviewsForAnalysis(admin, workspace_id, product_id);
  if (reviews.length === 0) {
    await persistReviewAnalysis(admin, workspace_id, product_id, null, 0, 0);
    return { analyzed: 0 };
  }
  const chunks: ReviewLite[][] = [];
  for (let i = 0; i < reviews.length; i += REVIEW_CHUNK) chunks.push(reviews.slice(i, i + REVIEW_CHUNK));
  const partials: ReviewAnalysisResult[] = [];
  for (const chunk of chunks) partials.push(await analyzeReviewChunk(chunk));
  const reduced = reduceReviewAnalysis(reviews, partials);
  await persistReviewAnalysis(admin, workspace_id, product_id, reduced, reviews.length, chunks.length);
  return { analyzed: reviews.length };
}

/** Research ALL ingredients to completion (box path), fault-isolated per ingredient. */
export async function researchIngredientsCore(
  admin: Admin,
  args: { workspace_id: string; product_id: string; ingredient_ids?: string[] },
): Promise<{ researched: number; failed: string[] }> {
  const { workspace_id, product_id, ingredient_ids } = args;
  const { data: product } = await admin
    .from("products")
    .select("id, title, target_customer, certifications")
    .eq("id", product_id)
    .eq("workspace_id", workspace_id)
    .single();

  let query = admin
    .from("product_ingredients")
    .select("id, name, dosage_mg, dosage_display, display_order")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("display_order");
  if (ingredient_ids && ingredient_ids.length > 0) query = query.in("id", ingredient_ids);
  const { data: ingredients } = await query;
  const list = (ingredients || []) as IngredientLite[];

  if (!product || list.length === 0) return { researched: 0, failed: [] };

  const targetCustomer = product.target_customer || "general adult population";
  const failed: string[] = [];
  for (const ing of list) {
    try {
      await researchOneIngredient(admin, { workspace_id, product_id, ing, targetCustomer });
    } catch (e) {
      failed.push(ing.name);
      console.error(`[engine] research "${ing.name}" failed — skipping:`, e instanceof Error ? e.message : e);
    }
  }
  return { researched: list.length - failed.length, failed };
}

// ============================================================================
// Content generation
// ============================================================================

export type GeneratedContent = {
  hero_headline?: string;
  hero_subheadline?: string;
  benefit_bar?: Array<{ icon_hint?: string; text: string }>;
  mechanism_copy?: string;
  ingredient_cards?: Array<{ name: string; headline: string; body: string; confidence?: number; image_slot?: string }>;
  comparison_table_rows?: Array<{ feature: string; us: string; competitor_generic: string }>;
  faq_items?: Array<{ question: string; answer: string }>;
  guarantee_copy?: string;
  knowledge_base_article?: string;
  kb_what_it_doesnt_do?: string;
  support_macros?: Array<{ title: string; body_text: string; body_html?: string; question_type: string }>;
  endorsements?: Array<{ name: string; title: string; quote: string; bullets: string[] }>;
  expectation_timeline?: Array<{ time_label: string; headline: string; body: string }>;
};

export const CONTENT_SYSTEM = `You are a conversion-focused DTC copywriter and knowledge base author. You write in plain outcome language from customer reviews, not clinical jargon. Respond with strict JSON only — no prose, no markdown fences.

RULES:
- Hero headline: outcome language from customer reviews, not clinical language.
- Never claim benefits with confidence < 0.5 as primary claims.
- benefit_bar: exactly 4-6 items; lead benefits first.
- mechanism_copy: must directly deliver on EVERY item in benefit_bar.
    This block renders as the 'Why this works' section right below the
    hero, so the copy has to make the customer feel that the benefit
    chips on the hero are real. Open with one connective sentence, then
    explain HOW the formulation produces each benefit chip — in the
    same order as benefit_bar.
    READING LEVEL: 8th grade. Target Flesch-Kincaid grade ≤ 8.
      * Short sentences. 12-15 words max. One idea per sentence.
      * Use everyday words. Say "calms the brain" not "reduces
        neuroinflammation"; "burns fat" not "boosts fat oxidation";
        "keeps blood sugar steady" not "modulates glucose absorption";
        "feels smooth" not "without jitters or vasoconstriction."
      * Never use: blood-brain barrier, chlorogenic acids,
        cardiovascular, glucose absorption, neuroinflammation,
        vasodilation, bioavailability, antioxidant-rich, modulates,
        upregulates, mechanism, pathway. If a term needs jargon, find
        another way to say it.
      * No semicolons. No "while X, Y" pairs.
      * Ingredients OK to name, but tie each to a plain-language effect.
      * Never invent customer quotes.
- endorsements: exactly 3 distinct nutritionists. Vary their
  credentials, voices, and angles so no two cards read the same.
- FAQ: 5-8 items.
- Compare to generic alternatives — never name competitor brands.
- comparison_table_rows: the storefront renders only the 'us' vs
  'competitor_generic' columns — the 'feature' column is no longer
  shown. Each string on its OWN must imply what is being compared.
  Write the 'us' side as a complete claim ('12 functional ingredients',
  '165mg natural energy from coffee + matcha') and the
  'competitor_generic' side as a parallel-shaped negation
  ('Just caffeine', 'Synthetic caffeine only'). Keep the 'feature'
  field populated as an internal label, but assume the customer never
  sees it.
- Never invent customer quotes.
- Macros: always write in plain, accurate, professional customer support voice.`;

type ContentProduct = { title: string; target_customer: string | null; certifications: string[] | null };
type ContentContext = {
  product: ContentProduct;
  ingredients: Array<{ id: string; name: string; dosage_display: string | null; display_order?: number }>;
  research: Array<{ ingredient_id: string; benefit_headline: string; mechanism_explanation: string; dosage_comparison: string | null; ai_confidence: number }>;
  benefitSelections: unknown;
  reviewAnalysis: unknown;
  media: Array<{ slot: string }>;
};

export function buildContentUserPrompt(context: ContentContext): string {
  const { product } = context;
  return `Generate product page content as a single JSON object with these keys:

{
  "hero_headline": "string",
  "hero_subheadline": "string",
  "benefit_bar": [{ "icon_hint": "string", "text": "string" }],
  "mechanism_copy": "string (2-4 sentences)",
  "ingredient_cards": [{ "name": "string", "headline": "string", "body": "string", "confidence": number, "image_slot": "string" }],
  "comparison_table_rows": [{ "feature": "string", "us": "string", "competitor_generic": "string" }],
  "faq_items": [{ "question": "string", "answer": "string" }],
  "guarantee_copy": "string",
  "knowledge_base_article": "string (markdown, deep reference article)",
  "kb_what_it_doesnt_do": "string (explicit limits — required)",
  "support_macros": [
    { "title": "string", "body_text": "string", "body_html": "string", "question_type": "ingredients" },
    { "title": "string", "body_text": "string", "body_html": "string", "question_type": "dosage" },
    { "title": "string", "body_text": "string", "body_html": "string", "question_type": "benefits" },
    { "title": "string", "body_text": "string", "body_html": "string", "question_type": "side_effects" },
    { "title": "string", "body_text": "string", "body_html": "string", "question_type": "usage" }
  ],
  "endorsements": [
    {
      "name": "string (e.g. 'Dr. Jane Doe, RD' — three distinct fictional but plausible nutritionists/dietitians/clinicians; vary credentials across the three: RD, RDN, CN, PhD, MS, etc.)",
      "title": "string (e.g. 'Registered Dietitian', 'Clinical Nutritionist', 'Sports Dietitian')",
      "quote": "string (1-3 plain-language sentences from this person's perspective — why they'd recommend this. Each of the three quotes must hit a different angle: e.g. ingredient quality, daily habit fit, real-world client results.)",
      "bullets": ["string (3-5 short reasons, each <= 12 words, why this product earns the recommendation)"]
    }
  ],
  "expectation_timeline": [
    { "time_label": "string (e.g. 'Day 1', 'Week 2', 'Month 1')", "headline": "string (short, 3-6 words)", "body": "string (1 sentence, plain language)" }
  ]
}

PRODUCT:
Title: ${product.title}
Target customer: ${product.target_customer || "general adult"}
Certifications: ${(product.certifications || []).join(", ") || "none"}

INGREDIENTS & RESEARCH:
${JSON.stringify(
  context.ingredients.map((i) => ({
    name: i.name,
    dosage: i.dosage_display,
    research: context.research
      .filter((r) => r.ingredient_id === i.id)
      .map((r) => ({
        benefit: r.benefit_headline,
        mechanism: r.mechanism_explanation,
        dosage_comparison: r.dosage_comparison,
        confidence: r.ai_confidence,
      })),
  })),
)}

SELECTED BENEFITS (final editorial decisions — base hero & benefit_bar on these):
${JSON.stringify(context.benefitSelections)}

REVIEW VOICE (use exact customer phrases for outcome language):
${JSON.stringify(context.reviewAnalysis || {})}

AVAILABLE IMAGE SLOTS: ${context.media.map((m) => m.slot).join(", ") || "(none uploaded yet)"}

Return the JSON object only.`;
}

/**
 * Generate page content to completion: fetch context → Sonnet → insert a new
 * `product_page_content` version (status='draft'). Does NOT change
 * `intelligence_status` (the caller owns that). Throws if the product is
 * missing or the AI call fails.
 */
export async function generateContentCore(
  admin: Admin,
  args: { workspace_id: string; product_id: string },
): Promise<{ generated: boolean; version: number }> {
  const { workspace_id, product_id } = args;

  const { data: product } = await admin
    .from("products")
    .select("id, title, target_customer, certifications, description, handle")
    .eq("id", product_id)
    .eq("workspace_id", workspace_id)
    .single();
  if (!product) throw new Error("Product not found");

  const { data: ingredients } = await admin
    .from("product_ingredients")
    .select("id, name, dosage_display, display_order")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("display_order");

  const { data: research } = await admin
    .from("product_ingredient_research")
    .select("id, ingredient_id, benefit_headline, mechanism_explanation, dosage_comparison, ai_confidence, citations")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id);

  const { data: reviewAnalysis } = await admin
    .from("product_review_analysis")
    .select("top_benefits, before_after_pain_points, skeptic_conversions, surprise_benefits, most_powerful_phrases, reviews_analyzed_count")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .maybeSingle();

  const { data: benefitSelections } = await admin
    .from("product_benefit_selections")
    .select("benefit_name, role, display_order, science_confirmed, customer_confirmed, customer_phrases, ai_confidence, notes")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .in("role", ["lead", "supporting"])
    .order("display_order");

  const { data: media } = await admin
    .from("product_media")
    .select("slot, url, alt_text")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id);

  const context: ContentContext = {
    product: product as ContentProduct,
    ingredients: (ingredients || []) as ContentContext["ingredients"],
    research: (research || []) as ContentContext["research"],
    benefitSelections: benefitSelections || [],
    reviewAnalysis: reviewAnalysis || {},
    media: (media || []) as Array<{ slot: string }>,
  };

  const result = await callSonnet(CONTENT_SYSTEM, buildContentUserPrompt(context), 8192, 0.2);
  if (!result) throw new Error("No Anthropic API key or AI call failed");

  const parsed = extractJson<GeneratedContent>(result.text) || {};

  const { data: latest } = await admin
    .from("product_page_content")
    .select("version")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (latest?.version || 0) + 1;

  await admin.from("product_page_content").insert({
    workspace_id,
    product_id,
    version: nextVersion,
    hero_headline: parsed.hero_headline || null,
    hero_subheadline: parsed.hero_subheadline || null,
    benefit_bar: Array.isArray(parsed.benefit_bar) ? parsed.benefit_bar : [],
    mechanism_copy: parsed.mechanism_copy || null,
    ingredient_cards: Array.isArray(parsed.ingredient_cards) ? parsed.ingredient_cards : [],
    comparison_table_rows: Array.isArray(parsed.comparison_table_rows) ? parsed.comparison_table_rows : [],
    faq_items: Array.isArray(parsed.faq_items) ? parsed.faq_items : [],
    guarantee_copy: parsed.guarantee_copy || null,
    knowledge_base_article: parsed.knowledge_base_article || null,
    kb_what_it_doesnt_do: parsed.kb_what_it_doesnt_do || null,
    support_macros: Array.isArray(parsed.support_macros) ? parsed.support_macros : [],
    endorsements: Array.isArray(parsed.endorsements) ? parsed.endorsements : [],
    expectation_timeline: Array.isArray(parsed.expectation_timeline) ? parsed.expectation_timeline : [],
    raw_ai_response: result.raw as Record<string, unknown>,
    status: "draft",
    generated_at: new Date().toISOString(),
  });

  return { generated: true, version: nextVersion };
}
