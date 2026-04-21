/**
 * SEO Keyword Research — generates candidate keywords from product intelligence,
 * fetches real search volume from Google Ads Keyword Planner, and merges with
 * Search Console data for existing rankings.
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateKeywordIdeas } from "@/lib/google-ads";
import { getSearchAnalytics } from "@/lib/google-search-console";

const SONNET = "claude-sonnet-4-20250514";

export const seoKeywordResearch = inngest.createFunction(
  {
    id: "seo-keyword-research",
    retries: 1,
    concurrency: [{ limit: 2, key: "event.data.workspace_id" }],
    triggers: [{ event: "seo/research-keywords" }],
  },
  async ({ event, step }) => {
    const { workspace_id, product_id } = event.data as {
      workspace_id: string;
      product_id: string;
    };

    const admin = createAdminClient();

    // Step 1: Gather all product intelligence for seed keyword generation
    const context = await step.run("fetch-context", async () => {
      const [productRes, contentRes, selectionsRes, ingredientsRes, reviewRes] = await Promise.all([
        admin.from("products").select("title, handle, description, target_customer, certifications, allergen_free, awards").eq("id", product_id).single(),
        admin.from("product_page_content").select("hero_headline, hero_subheadline, benefit_bar, faq_items, mechanism_copy").eq("product_id", product_id).order("version", { ascending: false }).limit(1).maybeSingle(),
        admin.from("product_benefit_selections").select("benefit_name, role").eq("product_id", product_id).eq("role", "lead"),
        admin.from("product_ingredients").select("name").eq("product_id", product_id),
        admin.from("product_review_analysis").select("top_benefits, most_powerful_phrases").eq("product_id", product_id).maybeSingle(),
      ]);

      return {
        product: productRes.data,
        content: contentRes.data,
        leadBenefits: (selectionsRes.data || []).map(s => s.benefit_name),
        ingredients: (ingredientsRes.data || []).map(i => i.name),
        reviewBenefits: ((reviewRes.data?.top_benefits || []) as { benefit: string }[]).map(b => b.benefit),
        customerPhrases: ((reviewRes.data?.most_powerful_phrases || []) as { phrase: string }[]).map(p => p.phrase),
      };
    });

    // Step 2: Use Claude to generate seed keywords from product intelligence
    const seedKeywords = await step.run("generate-seeds", async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return [];

      const prompt = `You are an SEO keyword researcher for a supplement/health product.

Product: ${context.product?.title}
Description: ${context.product?.description?.slice(0, 200) || "N/A"}
Target Customer: ${context.product?.target_customer || "N/A"}
Lead Benefits: ${context.leadBenefits.join(", ")}
Ingredients: ${context.ingredients.join(", ")}
Customer-reported benefits: ${context.reviewBenefits.join(", ")}
Customer phrases: ${context.customerPhrases.slice(0, 10).map(p => `"${p}"`).join(", ")}

Generate 30-50 seed keywords that potential customers would search for. Include:
1. Product-category keywords (e.g. "mushroom coffee", "superfood coffee")
2. Benefit-driven keywords (e.g. "coffee for energy without jitters", "natural appetite suppressant")
3. Ingredient keywords (e.g. "chaga mushroom benefits", "matcha coffee blend")
4. Problem-solution keywords (e.g. "how to reduce brain fog naturally", "coffee that helps with weight loss")
5. Comparison keywords (e.g. "mushroom coffee vs regular coffee", "best superfood coffee")
6. Long-tail conversational keywords (e.g. "what is the best coffee for women over 50")
7. Brand-adjacent keywords (e.g. "superfoods company coffee", "superfood tabs coffee")

Return a JSON array of strings — just the keywords, no explanations.`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SONNET, max_tokens: 2048, temperature: 0.3,
          system: "Return strict JSON only — a flat array of keyword strings.",
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) return [];
      const data = await res.json();
      const text = (data.content || []).find((c: { type: string }) => c.type === "text")?.text || "[]";
      try {
        const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed.filter((k: unknown) => typeof k === "string") : [];
      } catch {
        return [];
      }
    });

    if (seedKeywords.length === 0) return { error: "No seed keywords generated" };

    // Step 3: Fetch real search volume from Google Ads Keyword Planner
    const keywordData = await step.run("fetch-keyword-planner", async () => {
      // Process in batches of 20 (API limit)
      const allResults: Awaited<ReturnType<typeof generateKeywordIdeas>> = [];
      for (let i = 0; i < seedKeywords.length; i += 20) {
        const batch = seedKeywords.slice(i, i + 20);
        const results = await generateKeywordIdeas(workspace_id, batch);
        allResults.push(...results);
        if (i + 20 < seedKeywords.length) {
          await new Promise(r => setTimeout(r, 1000)); // rate limit
        }
      }
      return allResults;
    });

    // Step 4: Fetch Search Console data (existing rankings)
    const searchConsoleData = await step.run("fetch-search-console", async () => {
      const handle = context.product?.handle;
      return await getSearchAnalytics(workspace_id, {
        pageFilter: handle ? `/${handle}` : undefined,
        days: 90,
        limit: 200,
      });
    });

    // Step 5: Merge and save all keyword data
    await step.run("save-keywords", async () => {
      // Build a map of all keywords
      const keywordMap = new Map<string, {
        monthly_searches: number;
        competition: string;
        competition_index: number;
        cpc_low_cents: number;
        cpc_high_cents: number;
        relevance: string;
        source: string;
        sc_clicks: number;
        sc_impressions: number;
        sc_ctr: number;
        sc_position: number;
      }>();

      // Add Keyword Planner data
      for (const k of keywordData) {
        const relevance = k.monthly_searches >= 1000 ? "primary"
          : k.monthly_searches >= 100 ? "secondary"
          : "long_tail";
        keywordMap.set(k.keyword.toLowerCase(), {
          monthly_searches: k.monthly_searches,
          competition: k.competition,
          competition_index: k.competition_index,
          cpc_low_cents: k.cpc_low_cents,
          cpc_high_cents: k.cpc_high_cents,
          relevance,
          source: "keyword_planner",
          sc_clicks: 0, sc_impressions: 0, sc_ctr: 0, sc_position: 0,
        });
      }

      // Merge Search Console data
      for (const q of searchConsoleData) {
        const key = q.keyword.toLowerCase();
        const existing = keywordMap.get(key);
        if (existing) {
          existing.sc_clicks = q.clicks;
          existing.sc_impressions = q.impressions;
          existing.sc_ctr = q.ctr;
          existing.sc_position = q.position;
        } else {
          keywordMap.set(key, {
            monthly_searches: 0,
            competition: "UNSPECIFIED",
            competition_index: 0,
            cpc_low_cents: 0,
            cpc_high_cents: 0,
            relevance: "long_tail",
            source: "search_console",
            sc_clicks: q.clicks,
            sc_impressions: q.impressions,
            sc_ctr: q.ctr,
            sc_position: q.position,
          });
        }
      }

      // Also add the AI-suggested seeds that weren't in Keyword Planner results
      for (const seed of seedKeywords) {
        const key = seed.toLowerCase();
        if (!keywordMap.has(key)) {
          keywordMap.set(key, {
            monthly_searches: 0,
            competition: "UNSPECIFIED",
            competition_index: 0,
            cpc_low_cents: 0,
            cpc_high_cents: 0,
            relevance: "long_tail",
            source: "ai_suggested",
            sc_clicks: 0, sc_impressions: 0, sc_ctr: 0, sc_position: 0,
          });
        }
      }

      // Clear existing keywords for this product and insert fresh
      await admin.from("product_seo_keywords")
        .delete()
        .eq("workspace_id", workspace_id)
        .eq("product_id", product_id);

      const rows = [...keywordMap.entries()].map(([keyword, data]) => ({
        workspace_id,
        product_id,
        keyword,
        monthly_searches: data.monthly_searches,
        competition: data.competition,
        competition_index: data.competition_index,
        cpc_low_cents: data.cpc_low_cents,
        cpc_high_cents: data.cpc_high_cents,
        relevance: data.relevance,
        source: data.source,
        search_console_clicks: data.sc_clicks,
        search_console_impressions: data.sc_impressions,
        search_console_ctr: data.sc_ctr,
        search_console_position: data.sc_position,
        is_selected: false,
      }));

      // Insert in batches
      for (let i = 0; i < rows.length; i += 100) {
        await admin.from("product_seo_keywords").insert(rows.slice(i, i + 100));
      }

      return { total: rows.length, from_planner: keywordData.length, from_console: searchConsoleData.length, ai_seeds: seedKeywords.length };
    });

    return { success: true };
  },
);
