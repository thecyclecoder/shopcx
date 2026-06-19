/**
 * Auto benefit-selection (box-product-seeding step 4) — replaces the manual
 * Engine UI step. Triangulates THREE sources and picks the strongest:
 *   (a) our existing framing — the PDP angle (an anchor, not a ceiling),
 *   (b) benefits implied by clinical studies (product_ingredient_research),
 *   (c) benefits implied by reviews (product_review_analysis.top_benefits).
 *
 * Same shape as the UI's `reconcile-benefits` route, plus the PDP-angle anchor
 * and an automatic lead/supporting/skip pick. Each pick carries its evidence
 * (review IDs + ingredient_research IDs) so the self-QA gate can trace claims.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { callSonnet, extractJson } from "./engine";
import { fetchPdpText } from "./extract-ingredients";

type Admin = ReturnType<typeof createAdminClient>;

type ReconcileTheme = {
  theme_name: string;
  science_confirmed: boolean;
  customer_confirmed: boolean;
  max_confidence: number | null;
  research_ids: string[];
  ingredient_names: string[];
  customer_benefit_names: string[];
  customer_phrases: string[];
  recommendation: "lead" | "supporting" | "skip";
  reason: string;
};

type TopBenefit = { benefit: string; frequency?: number; customer_phrases?: string[]; review_ids?: string[] };

/**
 * Run the triangulated selection and persist `product_benefit_selections`.
 * Returns the chosen themes (lead/supporting kept; skips dropped from the count).
 */
export async function selectBenefits(
  admin: Admin,
  args: { workspace_id: string; product_id: string; handle?: string | null; angle_override?: string | null },
): Promise<{ themes: ReconcileTheme[]; lead: number; supporting: number }> {
  const { workspace_id, product_id, handle, angle_override } = args;

  const [researchRes, analysisRes, ingredientsRes] = await Promise.all([
    admin
      .from("product_ingredient_research")
      .select("id, ingredient_id, benefit_headline, ai_confidence, mechanism_explanation")
      .eq("workspace_id", workspace_id)
      .eq("product_id", product_id),
    admin
      .from("product_review_analysis")
      .select("top_benefits")
      .eq("workspace_id", workspace_id)
      .eq("product_id", product_id)
      .maybeSingle(),
    admin
      .from("product_ingredients")
      .select("id, name")
      .eq("workspace_id", workspace_id)
      .eq("product_id", product_id),
  ]);

  const research = researchRes.data || [];
  const topBenefits = (analysisRes.data?.top_benefits || []) as TopBenefit[];
  const ingredientMap = new Map((ingredientsRes.data || []).map((i) => [i.id, i.name]));
  if (research.length === 0 && topBenefits.length === 0) return { themes: [], lead: 0, supporting: 0 };

  // benefit string (lowercased) → review_ids, for evidence attribution.
  const reviewIdsByBenefit = new Map<string, string[]>();
  for (const b of topBenefits) {
    if (b?.benefit) reviewIdsByBenefit.set(b.benefit.trim().toLowerCase(), (b.review_ids || []).filter(Boolean));
  }

  // (a) Our existing framing — the PDP angle as an ANCHOR.
  let anchor = (angle_override || "").trim();
  if (!anchor && handle) {
    const pdp = await fetchPdpText(handle);
    if (pdp) anchor = pdp.slice(0, 6000);
  }

  const scienceList = research
    .map((r) => `- "${r.benefit_headline}" (${ingredientMap.get(r.ingredient_id) || "?"}, confidence: ${r.ai_confidence}) [research_id: ${r.id}]`)
    .join("\n");
  const customerList = topBenefits
    .map((b) => `- "${b.benefit}" (mentioned ${b.frequency ?? 0}x) — phrases: ${(b.customer_phrases || []).slice(0, 3).map((p) => `"${p}"`).join(", ")}`)
    .join("\n");

  const system = "You are a product marketing analyst. Return strict JSON only — no prose, no markdown fences.";
  const prompt = `You are choosing the lead + supporting benefits for a product page. Triangulate THREE sources and pick the strongest — favor benefits where clinical evidence and real customer language CONVERGE. The existing framing is an ANCHOR, not a ceiling: surface a BETTER benefit than the current angle when the data supports it (don't just rubber-stamp the existing angle).

(a) OUR EXISTING FRAMING (the product page's current angle — an anchor):
${anchor || "(no angle text available — infer from the science + customer data)"}

(b) SCIENCE BENEFITS (from ingredient research):
${scienceList || "(none)"}

(c) CUSTOMER BENEFITS (from review analysis):
${customerList || "(none)"}

Group these into unified BENEFIT THEMES. A theme combines related science benefits and customer benefits that mean the same thing, even in different words.

Rules:
- Combine redundant/overlapping science benefits into one theme.
- A theme can pull science from multiple ingredients and multiple customer benefits.
- If a customer benefit has NO science backing, still include it (customer_only).
- If a science benefit has NO customer mention, still include it (science_only).
- Marketing-friendly theme names (not clinical jargon).
- max_confidence = the highest ai_confidence of any linked research (or null).
- recommendation: "lead" for the 1-3 strongest (prefer BOTH science+customer confirmed and high confidence), "supporting" for solid secondary themes, "skip" for weak/unsupported.
- Order: both-confirmed first (confidence desc), then customer_only (frequency desc), then science_only.

Return JSON array:
[{
  "theme_name": "string",
  "science_confirmed": boolean,
  "customer_confirmed": boolean,
  "max_confidence": number or null,
  "research_ids": ["ids of all linked research rows"],
  "ingredient_names": ["names of ingredients contributing"],
  "customer_benefit_names": ["original customer benefit strings that match"],
  "customer_phrases": ["best 2-3 exact customer phrases"],
  "recommendation": "lead" | "supporting" | "skip",
  "reason": "brief explanation tying the pick to the three sources"
}]`;

  const resp = await callSonnet(system, prompt, 8192, 0);
  const themes = (extractJson<ReconcileTheme[] | { themes: ReconcileTheme[] }>(resp?.text || "") as ReconcileTheme[] | { themes: ReconcileTheme[] } | null);
  const themeList: ReconcileTheme[] = Array.isArray(themes)
    ? themes
    : themes && typeof themes === "object" && Array.isArray((themes as { themes?: ReconcileTheme[] }).themes)
      ? (themes as { themes: ReconcileTheme[] }).themes
      : [];
  if (themeList.length === 0) return { themes: [], lead: 0, supporting: 0 };

  // Map themes → product_benefit_selections rows (same columns the UI PUT writes).
  const validResearchIds = new Set(research.map((r) => r.id));
  const rows = themeList.map((t, i) => {
    const role = (["lead", "supporting", "skip"] as const).includes(t.recommendation) ? t.recommendation : "supporting";
    const customerReviewIds = [
      ...new Set(
        (t.customer_benefit_names || []).flatMap((n) => reviewIdsByBenefit.get(n.trim().toLowerCase()) || []),
      ),
    ];
    const researchIds = (t.research_ids || []).filter((id) => validResearchIds.has(id));
    return {
      workspace_id,
      product_id,
      benefit_name: t.theme_name,
      role,
      display_order: i,
      science_confirmed: !!t.science_confirmed,
      customer_confirmed: !!t.customer_confirmed,
      customer_phrases: Array.isArray(t.customer_phrases) ? t.customer_phrases : [],
      customer_review_ids: customerReviewIds,
      ingredient_research_ids: researchIds,
      ai_confidence: typeof t.max_confidence === "number" ? t.max_confidence : null,
      notes: `${(t.ingredient_names || []).length ? "Ingredients: " + t.ingredient_names.join(", ") : ""}${(t.customer_benefit_names || []).length ? " | Customer: " + t.customer_benefit_names.join(", ") : ""}`.trim(),
    };
  });

  // Replace prior selections cleanly (idempotent re-run).
  await admin.from("product_benefit_selections").delete().eq("workspace_id", workspace_id).eq("product_id", product_id);
  const { error } = await admin.from("product_benefit_selections").insert(rows);
  if (error) throw new Error(`benefit_selection_insert: ${error.message}`);

  return {
    themes: themeList,
    lead: rows.filter((r) => r.role === "lead").length,
    supporting: rows.filter((r) => r.role === "supporting").length,
  };
}
