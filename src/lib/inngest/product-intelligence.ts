/**
 * Product Intelligence Engine — Phase 1
 * Three Inngest functions:
 *   - intelligence/research-ingredients — AI research per ingredient
 *   - intelligence/analyze-reviews — AI review analysis
 *   - intelligence/generate-content — AI page content generation
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";

const SONNET = "claude-sonnet-4-20250514";

type AnthropicContentBlock = { type: string; text?: string };

async function callSonnet(
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
): Promise<{ text: string; raw: unknown } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
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
  });
  if (!res.ok) {
    throw new Error(`Anthropic error: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  const text = (data.content as AnthropicContentBlock[])
    ?.map((b) => (b.type === "text" ? b.text || "" : ""))
    .join("")
    .trim() || "";
  return { text, raw: data };
}

function extractJson<T = unknown>(text: string): T | null {
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
// 3a. intelligence/research-ingredients
// ============================================================================

type IngredientBenefit = {
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

export const researchIngredients = inngest.createFunction(
  {
    id: "intelligence-research-ingredients",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/research-ingredients" }],
  },
  async ({ event, step }) => {
    const { workspace_id, product_id, ingredient_ids } = event.data as {
      workspace_id: string;
      product_id: string;
      ingredient_ids?: string[];
    };

    const context = await step.run("fetch-ingredients", async () => {
      const admin = createAdminClient();
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

      if (ingredient_ids && ingredient_ids.length > 0) {
        query = query.in("id", ingredient_ids);
      }

      const { data: ingredients } = await query;
      return { product, ingredients: ingredients || [] };
    });

    if (!context.product || context.ingredients.length === 0) {
      await step.run("update-status", async () => {
        const admin = createAdminClient();
        await admin
          .from("products")
          .update({ intelligence_status: "ingredients_added" })
          .eq("id", product_id)
          .eq("workspace_id", workspace_id);
      });
      return { researched: 0, error: "No ingredients to research" };
    }

    const targetCustomer = context.product.target_customer || "general adult population";

    for (const ing of context.ingredients) {
      await step.run(`research-${ing.id}`, async () => {
        const admin = createAdminClient();
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
          : (parsed && typeof parsed === "object" && "benefits" in parsed && Array.isArray(parsed.benefits))
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
              typeof b.ai_confidence === "number"
                ? Math.max(0, Math.min(1, b.ai_confidence))
                : 0.5,
            raw_ai_response: result.raw as Record<string, unknown>,
          }));

        if (rows.length > 0) {
          await admin.from("product_ingredient_research").insert(rows);
        }
      });
    }

    await step.run("update-status", async () => {
      const admin = createAdminClient();
      await admin
        .from("products")
        .update({ intelligence_status: "research_complete" })
        .eq("id", product_id)
        .eq("workspace_id", workspace_id);
    });

    return { researched: context.ingredients.length };
  },
);

// ============================================================================
// 3b. intelligence/analyze-reviews
// ============================================================================

type ReviewAnalysisResult = {
  top_benefits?: Array<{
    benefit: string;
    frequency: number;
    customer_phrases?: string[];
    review_ids?: string[];
  }>;
  before_after_pain_points?: Array<{
    before: string;
    after: string;
    review_ids?: string[];
  }>;
  skeptic_conversions?: Array<{
    summary: string;
    quote: string;
    review_id?: string;
    reviewer_name?: string;
  }>;
  surprise_benefits?: Array<{
    benefit: string;
    quote: string;
    review_id?: string;
  }>;
  most_powerful_phrases?: Array<{
    phrase: string;
    context?: string;
    review_id?: string;
    reviewer_name?: string;
  }>;
};

export const analyzeReviews = inngest.createFunction(
  {
    id: "intelligence-analyze-reviews",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/analyze-reviews" }],
  },
  async ({ event, step }) => {
    const { workspace_id, product_id } = event.data as {
      workspace_id: string;
      product_id: string;
    };

    const reviews = await step.run("fetch-reviews", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("product_reviews")
        .select("id, reviewer_name, rating, title, body")
        .eq("workspace_id", workspace_id)
        .eq("product_id", product_id)
        .in("status", ["published", "featured"])
        .not("body", "is", null)
        .limit(500);

      return (data || []).filter((r) => (r.body || "").trim().length > 0);
    });

    if (reviews.length === 0) {
      await step.run("update-status-empty", async () => {
        const admin = createAdminClient();
        await admin.from("product_review_analysis").upsert(
          {
            workspace_id,
            product_id,
            top_benefits: [],
            before_after_pain_points: [],
            skeptic_conversions: [],
            surprise_benefits: [],
            most_powerful_phrases: [],
            reviews_analyzed_count: 0,
            analyzed_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,product_id" },
        );
        await admin
          .from("products")
          .update({ intelligence_status: "reviews_complete" })
          .eq("id", product_id)
          .eq("workspace_id", workspace_id);
      });
      return { analyzed: 0 };
    }

    const result = await step.run("analyze", async () => {
      const reviewsJson = reviews.map((r) => ({
        id: r.id,
        reviewer_name: r.reviewer_name || "Anonymous",
        rating: r.rating,
        title: r.title || "",
        body: r.body,
      }));

      const system = `You are a copywriting-focused review analyst. Every quote you return MUST be an EXACT substring from the review body. Every review_id MUST match one from the input. Respond with strict JSON only — no prose, no markdown fences.`;

      const user = `Analyze these ${reviews.length} product reviews and return a single JSON object with these keys:
- top_benefits: [{ benefit, frequency, customer_phrases: string[], review_ids: string[] }] — ranked by frequency, max 10
- before_after_pain_points: [{ before, after, review_ids: string[] }] — transformation stories
- skeptic_conversions: [{ summary, quote, review_id, reviewer_name }] — max 5
- surprise_benefits: [{ benefit, quote, review_id }] — unexpected benefits mentioned
- most_powerful_phrases: [{ phrase, context, review_id, reviewer_name }] — copywriting-ready quotes, max 15

Every quote must be an EXACT substring from a review body. Every review_id must appear in the input.

Reviews:
${JSON.stringify(reviewsJson)}`;

      const resp = await callSonnet(system, user, 8192, 0);
      return resp;
    });

    if (!result) {
      throw new Error("No Anthropic API key or AI call failed");
    }

    const parsed = extractJson<ReviewAnalysisResult>(result.text) || {};

    // Validate quotes / review_ids
    const validIds = new Set(reviews.map((r) => r.id));
    const bodyById = new Map(reviews.map((r) => [r.id, r.body || ""]));

    const filterReviewIds = (ids: unknown): string[] =>
      Array.isArray(ids)
        ? (ids.filter((id) => typeof id === "string" && validIds.has(id)) as string[])
        : [];

    const validateQuote = (review_id: string | undefined, quote: string | undefined): boolean => {
      if (!review_id || !quote) return false;
      if (!validIds.has(review_id)) return false;
      const body = bodyById.get(review_id) || "";
      return body.includes(quote);
    };

    const top_benefits = (parsed.top_benefits || []).map((b) => ({
      benefit: b.benefit,
      frequency: Number(b.frequency) || 0,
      customer_phrases: Array.isArray(b.customer_phrases) ? b.customer_phrases.slice(0, 10) : [],
      review_ids: filterReviewIds(b.review_ids),
    }));

    const before_after_pain_points = (parsed.before_after_pain_points || []).map((b) => ({
      before: b.before,
      after: b.after,
      review_ids: filterReviewIds(b.review_ids),
    }));

    const skeptic_conversions = (parsed.skeptic_conversions || []).filter((s) =>
      validateQuote(s.review_id, s.quote),
    );

    const surprise_benefits = (parsed.surprise_benefits || []).filter((s) =>
      validateQuote(s.review_id, s.quote),
    );

    const most_powerful_phrases = (parsed.most_powerful_phrases || []).filter((p) =>
      validateQuote(p.review_id, p.phrase),
    );

    await step.run("upsert-analysis", async () => {
      const admin = createAdminClient();
      await admin.from("product_review_analysis").upsert(
        {
          workspace_id,
          product_id,
          top_benefits,
          before_after_pain_points,
          skeptic_conversions,
          surprise_benefits,
          most_powerful_phrases,
          reviews_analyzed_count: reviews.length,
          raw_ai_response: result.raw as Record<string, unknown>,
          analyzed_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,product_id" },
      );
    });

    await step.run("update-status", async () => {
      const admin = createAdminClient();
      await admin
        .from("products")
        .update({ intelligence_status: "reviews_complete" })
        .eq("id", product_id)
        .eq("workspace_id", workspace_id);
    });

    return { analyzed: reviews.length };
  },
);

// ============================================================================
// 3c. intelligence/generate-content
// ============================================================================

type GeneratedContent = {
  hero_headline?: string;
  hero_subheadline?: string;
  benefit_bar?: Array<{ icon_hint?: string; text: string }>;
  mechanism_copy?: string;
  ingredient_cards?: Array<{
    name: string;
    headline: string;
    body: string;
    confidence?: number;
    image_slot?: string;
  }>;
  comparison_table_rows?: Array<{
    feature: string;
    us: string;
    competitor_generic: string;
  }>;
  faq_items?: Array<{ question: string; answer: string }>;
  guarantee_copy?: string;
  knowledge_base_article?: string;
  kb_what_it_doesnt_do?: string;
  support_macros?: Array<{
    title: string;
    body_text: string;
    body_html?: string;
    question_type: string;
  }>;
};

export const generateContent = inngest.createFunction(
  {
    id: "intelligence-generate-content",
    retries: 1,
    concurrency: [{ limit: 2, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/generate-content" }],
  },
  async ({ event, step }) => {
    const { workspace_id, product_id } = event.data as {
      workspace_id: string;
      product_id: string;
    };

    const context = await step.run("fetch-context", async () => {
      const admin = createAdminClient();

      const { data: product } = await admin
        .from("products")
        .select("id, title, target_customer, certifications, description, handle")
        .eq("id", product_id)
        .eq("workspace_id", workspace_id)
        .single();

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

      return {
        product,
        ingredients: ingredients || [],
        research: research || [],
        reviewAnalysis,
        benefitSelections: benefitSelections || [],
        media: media || [],
      };
    });

    const product = context.product;
    if (!product) {
      throw new Error("Product not found");
    }

    const result = await step.run("generate", async () => {
      const system = `You are a conversion-focused DTC copywriter and knowledge base author. You write in plain outcome language from customer reviews, not clinical jargon. Respond with strict JSON only — no prose, no markdown fences.

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
- FAQ: 5-8 items.
- Compare to generic alternatives — never name competitor brands.
- Never invent customer quotes.
- Macros: always write in plain, accurate, professional customer support voice.`;

      const user = `Generate product page content as a single JSON object with these keys:

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

      const resp = await callSonnet(system, user, 8192, 0.2);
      return resp;
    });

    if (!result) {
      throw new Error("No Anthropic API key or AI call failed");
    }

    const parsed = extractJson<GeneratedContent>(result.text) || {};

    await step.run("insert-content", async () => {
      const admin = createAdminClient();

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
        comparison_table_rows: Array.isArray(parsed.comparison_table_rows)
          ? parsed.comparison_table_rows
          : [],
        faq_items: Array.isArray(parsed.faq_items) ? parsed.faq_items : [],
        guarantee_copy: parsed.guarantee_copy || null,
        knowledge_base_article: parsed.knowledge_base_article || null,
        kb_what_it_doesnt_do: parsed.kb_what_it_doesnt_do || null,
        support_macros: Array.isArray(parsed.support_macros) ? parsed.support_macros : [],
        raw_ai_response: result.raw as Record<string, unknown>,
        status: "draft",
        generated_at: new Date().toISOString(),
      });
    });

    await step.run("update-status", async () => {
      const admin = createAdminClient();
      await admin
        .from("products")
        .update({ intelligence_status: "content_generated" })
        .eq("id", product_id)
        .eq("workspace_id", workspace_id);
    });

    return { generated: true };
  },
);

// =============================================================================
// Benefit Gap Research — targeted search for studies backing a customer benefit
// =============================================================================

export const researchBenefitGap = inngest.createFunction(
  {
    id: "intelligence-research-benefit-gap",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/research-benefit-gap" }],
  },
  async ({ event, step }) => {
    const { workspace_id, product_id, theme_name, customer_benefit_names } = event.data as {
      workspace_id: string;
      product_id: string;
      theme_name: string;
      customer_benefit_names: string[];
    };

    const context = await step.run("fetch-context", async () => {
      const admin = createAdminClient();
      const { data: ingredients } = await admin
        .from("product_ingredients")
        .select("id, name, dosage_display")
        .eq("workspace_id", workspace_id)
        .eq("product_id", product_id)
        .order("display_order");

      const { data: product } = await admin
        .from("products")
        .select("title, target_customer")
        .eq("id", product_id)
        .single();

      return { ingredients: ingredients || [], product };
    });

    if (!context.ingredients.length) return { found: 0 };

    const results = await step.run("research-gap", async () => {
      const admin = createAdminClient();
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return [];

      const ingredientList = context.ingredients
        .map(i => `- ${i.name}${i.dosage_display ? ` (${i.dosage_display})` : ""}`)
        .join("\n");

      const benefitTerms = customer_benefit_names.join(", ");

      const prompt = `Customers of "${context.product?.title || "this product"}" frequently report benefits related to: ${benefitTerms}

The product contains these ingredients:
${ingredientList}

Search for peer-reviewed studies linking ANY of these ingredients to the reported benefits. Think broadly — for example:
- "appetite suppression" could be supported by caffeine + metabolism studies, green tea + thermogenesis, matcha + satiety hormones
- "weight loss" could be supported by any ingredient with metabolic, thermogenic, or appetite-related research
- Related terms are the SAME category: appetite control, weight management, metabolism boost, fat oxidation, thermogenesis, satiety

For each ingredient where you find relevant research, return a benefit object. You may return multiple results if multiple ingredients have evidence.

Return JSON array:
[{
  "ingredient_name": "exact ingredient name from the list above",
  "benefit_headline": "Clear benefit headline related to ${theme_name}",
  "mechanism_explanation": "2-3 sentences on how this ingredient supports ${theme_name}",
  "clinically_studied_benefits": ["specific endpoints studied"],
  "dosage_comparison": "how the product dose compares to studied ranges, or null if dose unknown",
  "citations": [{"title": "string", "authors": "string", "journal": "string", "year": number, "doi": "string"}],
  "contraindications": "for ${context.product?.target_customer || "general population"}, or null",
  "ai_confidence": number (0-1, same scale: 1.0=multiple RCTs, 0.8=single RCT, etc.)
}]

If no relevant studies exist for any ingredient, return an empty array []. Be honest — don't stretch.`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: SONNET,
          max_tokens: 4096,
          temperature: 0,
          system: "You are a nutritional science researcher. Return strict JSON only — no prose, no markdown fences.",
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) return [];
      const data = await res.json();
      const text = (data.content || []).find((c: AnthropicContentBlock) => c.type === "text")?.text || "[]";
      const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      type GapBenefit = IngredientBenefit & { ingredient_name?: string };
      const benefits: GapBenefit[] = Array.isArray(parsed) ? parsed : parsed.benefits || [];

      // Save each result to product_ingredient_research
      const ingredientNameMap = new Map(context.ingredients.map(i => [i.name.toLowerCase(), i.id]));

      let saved = 0;
      for (const b of benefits) {
        if (!b.benefit_headline || !b.ingredient_name) continue;
        const ingredientId = ingredientNameMap.get(b.ingredient_name.toLowerCase());
        if (!ingredientId) continue;

        await admin.from("product_ingredient_research").upsert(
          {
            workspace_id,
            product_id,
            ingredient_id: ingredientId,
            benefit_headline: b.benefit_headline.trim(),
            mechanism_explanation: b.mechanism_explanation || "",
            clinically_studied_benefits: Array.isArray(b.clinically_studied_benefits) ? b.clinically_studied_benefits : [],
            dosage_comparison: b.dosage_comparison || null,
            citations: b.citations || [],
            contraindications: b.contraindications || null,
            ai_confidence: typeof b.ai_confidence === "number" ? b.ai_confidence : 0.5,
            raw_ai_response: null,
            researched_at: new Date().toISOString(),
          },
          { onConflict: "ingredient_id,benefit_headline" },
        );
        saved++;
      }

      return benefits.map(b => ({ ingredient: b.ingredient_name || "?", headline: b.benefit_headline, confidence: b.ai_confidence }));
    });

    return { theme: theme_name, found: results.length, results };
  },
);
