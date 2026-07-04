/**
 * Product Intelligence Engine — Phase 1
 * Three Inngest functions:
 *   - intelligence/research-ingredients — AI research per ingredient
 *   - intelligence/analyze-reviews — AI review analysis
 *   - intelligence/generate-content — AI page content generation
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SONNET_MODEL } from "@/lib/ai-models";
// Shared Engine core — the box (scripts/builder-worker.ts → runProductSeedJob)
// runs these SAME functions to completion. Reuse, never fork.
// See docs/brain/specs/box-product-seeding.md + src/lib/product-intelligence/engine.ts.
import {
  researchOneIngredient,
  fetchReviewsForAnalysis,
  analyzeReviewChunk,
  reduceReviewAnalysis,
  persistReviewAnalysis,
  generateContentCore,
  type IngredientBenefit,
  type IngredientLite,
  type ReviewAnalysisResult,
  REVIEW_CHUNK,
} from "@/lib/product-intelligence/engine";

const SONNET = SONNET_MODEL;

type AnthropicContentBlock = { type: string; text?: string };

// ============================================================================
// 3a. intelligence/research-ingredients
// ============================================================================

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

    // Fault-isolate each ingredient — a slow/timed-out Sonnet call that fails
    // after its retries used to abort the WHOLE function, leaving every later
    // ingredient unresearched (Superfood Tabs got only 4 of 16). Catch + continue.
    const failedIngredients: string[] = [];
    for (const ing of context.ingredients) {
      try {
      await step.run(`research-${ing.id}`, async () => {
        const admin = createAdminClient();
        await researchOneIngredient(admin, {
          workspace_id,
          product_id,
          ing: ing as IngredientLite,
          targetCustomer,
        });
      });
      } catch (e) {
        failedIngredients.push(ing.name);
        console.error(`[research-ingredients] "${ing.name}" failed after retries — skipping:`, e instanceof Error ? e.message : e);
      }
    }

    await step.run("update-status", async () => {
      const admin = createAdminClient();
      await admin
        .from("products")
        .update({ intelligence_status: "research_complete" })
        .eq("id", product_id)
        .eq("workspace_id", workspace_id);
    });

    return { researched: context.ingredients.length - failedIngredients.length, failed: failedIngredients };
  },
);

// ============================================================================
// 3b. intelligence/analyze-reviews
// ============================================================================

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

    // Best, product-specific reviews only: 4+★, non-empty body, featured-weighted,
    // longest first (shared engine — identical to the box path).
    const reviews = await step.run("fetch-reviews", async () => {
      const admin = createAdminClient();
      return fetchReviewsForAnalysis(admin, workspace_id, product_id);
    });

    if (reviews.length === 0) {
      await step.run("update-status-empty", async () => {
        const admin = createAdminClient();
        await persistReviewAnalysis(admin, workspace_id, product_id, null, 0, 0);
        await admin
          .from("products")
          .update({ intelligence_status: "reviews_complete" })
          .eq("id", product_id)
          .eq("workspace_id", workspace_id);
      });
      return { analyzed: 0 };
    }

    // ── Map: Sonnet reads the reviews in CHUNKS, never all at once. Each chunk is
    // its own step → fault-isolated + resumable. ──
    const chunks: (typeof reviews)[] = [];
    for (let i = 0; i < reviews.length; i += REVIEW_CHUNK) chunks.push(reviews.slice(i, i + REVIEW_CHUNK));

    const partials: ReviewAnalysisResult[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const partial = await step.run(`analyze-chunk-${ci}`, async () => analyzeReviewChunk(chunk));
      partials.push(partial);
    }

    // ── Reduce: merge per-chunk partials; validate against the full review set. ──
    const reduced = reduceReviewAnalysis(reviews, partials);

    await step.run("upsert-analysis", async () => {
      const admin = createAdminClient();
      await persistReviewAnalysis(admin, workspace_id, product_id, reduced, reviews.length, chunks.length);
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

    // Shared engine — fetch context → Sonnet → insert a new draft version.
    // The box (runProductSeedJob) calls this SAME generateContentCore.
    await step.run("generate-content", async () => {
      const admin = createAdminClient();
      return generateContentCore(admin, { workspace_id, product_id });
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
            max_tokens: 4096,
            temperature: 0,
            system: "You are a nutritional science researcher. Return strict JSON only — no prose, no markdown fences.",
            messages: [{ role: "user", content: prompt }],
          }),
          // Bound below the /api/inngest 800s Lambda cap so a stalled Sonnet call
          // aborts as a retryable fetch error instead of being reaped by Vercel.
          signal: AbortSignal.timeout(600_000),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === "AbortError" || name === "TimeoutError") {
          throw new Error("Anthropic call timed out after 600s");
        }
        throw err;
      }

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
