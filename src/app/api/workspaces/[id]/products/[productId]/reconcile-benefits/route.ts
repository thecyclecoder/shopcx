import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST: AI reconciliation — groups 64 science benefits + customer benefits into
 * unified themes. Returns pre-matched rows for the Benefits tab.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const [researchRes, analysisRes, ingredientsRes] = await Promise.all([
    admin.from("product_ingredient_research")
      .select("id, ingredient_id, benefit_headline, ai_confidence, mechanism_explanation")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId),
    admin.from("product_review_analysis")
      .select("top_benefits")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .maybeSingle(),
    admin.from("product_ingredients")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId),
  ]);

  const research = researchRes.data || [];
  const topBenefits = (analysisRes.data?.top_benefits || []) as {
    benefit: string; frequency: number; customer_phrases: string[]; review_ids?: string[];
  }[];
  const ingredientMap = new Map((ingredientsRes.data || []).map(i => [i.id, i.name]));

  if (research.length === 0 && topBenefits.length === 0) {
    return NextResponse.json({ themes: [] });
  }

  // Build context for Claude
  const scienceList = research.map(r =>
    `- "${r.benefit_headline}" (${ingredientMap.get(r.ingredient_id) || "?"}, confidence: ${r.ai_confidence}) [research_id: ${r.id}]`
  ).join("\n");

  const customerList = topBenefits.map(b =>
    `- "${b.benefit}" (mentioned ${b.frequency}x) — phrases: ${(b.customer_phrases || []).slice(0, 3).map(p => `"${p}"`).join(", ")}`
  ).join("\n");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });

  const prompt = `You have two data sets for a product:

SCIENCE BENEFITS (from ingredient research):
${scienceList}

CUSTOMER BENEFITS (from review analysis):
${customerList}

Group these into unified BENEFIT THEMES. A theme combines related science benefits and customer benefits that are talking about the same thing, even if they use different language.

For example:
- Science: "Enhances Cognitive Performance" + "Promotes Mental Alertness" + Customer: "Mental clarity/focus" → theme "Mental Clarity & Focus"
- Science: "Provides Anti-Inflammatory Effects" + "Supports Joint Health" + Customer: "No stomach issues" → theme "Anti-Inflammatory Support"
- Customer: "Weight loss" + "Appetite suppression" with NO direct science match → theme "Weight Management" (customer_only)

Rules:
- Combine redundant/overlapping science benefits into one theme (e.g., two ingredients both supporting cognition = one theme)
- A theme can have multiple science sources from different ingredients
- A theme can have multiple customer benefits that are really the same thing
- If a customer benefit has NO science backing at all, still include it as a customer_only theme
- If a science benefit has NO customer mention, still include it as a science_only theme
- Use clear, marketing-friendly theme names (not clinical jargon)
- The highest ai_confidence from any linked research becomes the theme's confidence
- Order themes by: both confirmed first (by confidence desc), then customer_only (by frequency desc), then science_only

Return JSON array:
[{
  "theme_name": "string — clear marketing-friendly name",
  "science_confirmed": boolean,
  "customer_confirmed": boolean,
  "max_confidence": number or null,
  "research_ids": ["ids of all linked research rows"],
  "ingredient_names": ["names of ingredients contributing"],
  "customer_benefit_names": ["original customer benefit strings that match"],
  "customer_phrases": ["best 2-3 exact customer phrases"],
  "recommendation": "lead" | "supporting" | "skip",
  "reason": "brief explanation of why this recommendation"
}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      temperature: 0,
      system: "You are a product marketing analyst. Return strict JSON only — no prose, no markdown fences.",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Anthropic error: ${res.status}` }, { status: 500 });
  }

  const data = await res.json();
  const text = (data.content || []).find((c: { type: string }) => c.type === "text")?.text || "[]";

  // Parse JSON — handle markdown fences and truncated responses
  let themes;
  try {
    let cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      themes = Array.isArray(parsed) ? parsed : parsed.themes || [];
    } catch {
      // Response may be truncated — try to salvage complete objects
      // Find the last complete object by looking for the last "},"
      const lastComplete = cleaned.lastIndexOf("},");
      if (lastComplete > 0) {
        cleaned = cleaned.slice(0, lastComplete + 1) + "]";
        const parsed = JSON.parse(cleaned);
        themes = Array.isArray(parsed) ? parsed : [];
      } else {
        throw new Error("Cannot parse");
      }
    }
  } catch {
    return NextResponse.json({ error: "Failed to parse AI response", raw: text.slice(0, 500) }, { status: 500 });
  }

  return NextResponse.json({ themes });
}
