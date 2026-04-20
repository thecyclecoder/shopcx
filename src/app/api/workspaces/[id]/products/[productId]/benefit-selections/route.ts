import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type IngredientResearchRow = {
  id: string;
  ingredient_id: string;
  benefit_headline: string;
  ai_confidence: number;
};

type TopBenefit = {
  benefit: string;
  frequency?: number;
  customer_phrases?: string[];
  review_ids?: string[];
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const [selectionsRes, researchRes, analysisRes, ingredientsRes] = await Promise.all([
    admin
      .from("product_benefit_selections")
      .select(
        "id, benefit_name, role, display_order, science_confirmed, customer_confirmed, customer_phrases, customer_review_ids, ingredient_research_ids, ai_confidence, notes",
      )
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("display_order"),
    admin
      .from("product_ingredient_research")
      .select("id, ingredient_id, benefit_headline, ai_confidence")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId),
    admin
      .from("product_review_analysis")
      .select("top_benefits")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .maybeSingle(),
    admin
      .from("product_ingredients")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId),
  ]);

  const selections = selectionsRes.data || [];
  const research = (researchRes.data || []) as IngredientResearchRow[];
  const topBenefits = (analysisRes.data?.top_benefits as TopBenefit[] | undefined) || [];
  const ingredientMap = new Map((ingredientsRes.data || []).map((i) => [i.id, i.name]));

  // Build science_sources and customer_sources per benefit in saved selections
  const benefits = selections.map((s) => {
    const scienceSources = ((s.ingredient_research_ids as string[] | null) || []).map((rid) => {
      const r = research.find((x) => x.id === rid);
      return r
        ? {
            ingredient_name: ingredientMap.get(r.ingredient_id) || "",
            benefit_headline: r.benefit_headline,
            confidence: r.ai_confidence,
          }
        : null;
    }).filter(Boolean);

    const customerSources = ((s.customer_phrases as string[] | null) || []).map((phrase, i) => ({
      phrase,
      review_id: (s.customer_review_ids as string[] | null)?.[i] || null,
    }));

    return {
      id: s.id,
      benefit_name: s.benefit_name,
      role: s.role,
      display_order: s.display_order,
      science_confirmed: s.science_confirmed,
      customer_confirmed: s.customer_confirmed,
      customer_phrases: s.customer_phrases || [],
      ai_confidence: s.ai_confidence,
      notes: s.notes,
      science_sources: scienceSources,
      customer_sources: customerSources,
    };
  });

  // Build AI suggestions for benefits not yet selected
  const existingNames = new Set(benefits.map((b) => b.benefit_name.toLowerCase()));

  const suggestions: Array<{
    benefit_name: string;
    science_confirmed: boolean;
    customer_confirmed: boolean;
    recommendation: "lead" | "supporting" | "skip";
    reason: string;
  }> = [];

  // From research — high confidence benefits not in selections
  for (const r of research) {
    if (existingNames.has(r.benefit_headline.toLowerCase())) continue;
    const customerMatch = topBenefits.find((t) =>
      (t.benefit || "").toLowerCase().includes(r.benefit_headline.toLowerCase()) ||
      r.benefit_headline.toLowerCase().includes((t.benefit || "").toLowerCase()),
    );
    const customerConfirmed = !!customerMatch;
    const recommendation: "lead" | "supporting" | "skip" =
      r.ai_confidence >= 0.7 && customerConfirmed
        ? "lead"
        : r.ai_confidence >= 0.5
          ? "supporting"
          : "skip";
    suggestions.push({
      benefit_name: r.benefit_headline,
      science_confirmed: true,
      customer_confirmed: customerConfirmed,
      recommendation,
      reason: customerConfirmed
        ? `Clinical confidence ${r.ai_confidence.toFixed(2)}; customers also mention this.`
        : `Clinical confidence ${r.ai_confidence.toFixed(2)}; no strong customer signal yet.`,
    });
    existingNames.add(r.benefit_headline.toLowerCase());
  }

  // From customer reviews — benefits not in research
  for (const t of topBenefits) {
    if (!t.benefit) continue;
    if (existingNames.has(t.benefit.toLowerCase())) continue;
    suggestions.push({
      benefit_name: t.benefit,
      science_confirmed: false,
      customer_confirmed: true,
      recommendation: (t.frequency || 0) >= 5 ? "supporting" : "skip",
      reason: `Mentioned ${t.frequency || 0} times by customers but no direct clinical research on file.`,
    });
    existingNames.add(t.benefit.toLowerCase());
  }

  return NextResponse.json({ benefits, suggestions });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const incoming = Array.isArray(body.benefits) ? body.benefits : [];

  // Enforce confidence floor on lead role
  for (const b of incoming) {
    if (
      b?.role === "lead" &&
      typeof b?.ai_confidence === "number" &&
      b.ai_confidence < 0.5
    ) {
      return NextResponse.json(
        {
          error: `Cannot mark "${b.benefit_name}" as lead — AI confidence ${b.ai_confidence.toFixed(
            2,
          )} is below the 0.5 floor.`,
        },
        { status: 400 },
      );
    }
  }

  // Delete existing, then insert fresh
  await admin
    .from("product_benefit_selections")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);

  if (incoming.length > 0) {
    const rows = incoming
      .filter((b: { benefit_name?: string; role?: string }) => b?.benefit_name && b?.role)
      .map((b: {
        benefit_name: string;
        role: "lead" | "supporting" | "skip";
        display_order?: number;
        science_confirmed?: boolean;
        customer_confirmed?: boolean;
        customer_phrases?: string[];
        customer_review_ids?: string[];
        ingredient_research_ids?: string[];
        ai_confidence?: number;
        notes?: string;
      }, i: number) => ({
        workspace_id: workspaceId,
        product_id: productId,
        benefit_name: b.benefit_name,
        role: b.role,
        display_order: typeof b.display_order === "number" ? b.display_order : i,
        science_confirmed: !!b.science_confirmed,
        customer_confirmed: !!b.customer_confirmed,
        customer_phrases: Array.isArray(b.customer_phrases) ? b.customer_phrases : [],
        customer_review_ids: Array.isArray(b.customer_review_ids) ? b.customer_review_ids : [],
        ingredient_research_ids: Array.isArray(b.ingredient_research_ids) ? b.ingredient_research_ids : [],
        ai_confidence: typeof b.ai_confidence === "number" ? b.ai_confidence : null,
        notes: b.notes || null,
      }));

    const { error } = await admin.from("product_benefit_selections").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await admin
    .from("products")
    .update({ intelligence_status: "benefits_selected" })
    .eq("id", productId)
    .eq("workspace_id", workspaceId);

  return NextResponse.json({ success: true });
}
