import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

  const [
    productRes,
    ingredientsRes,
    researchRes,
    analysisRes,
    selectionsRes,
    contentRes,
    mediaRes,
  ] = await Promise.all([
    admin
      .from("products")
      .select("id, title, target_customer, certifications, intelligence_status, image_url")
      .eq("id", productId)
      .eq("workspace_id", workspaceId)
      .single(),
    admin
      .from("product_ingredients")
      .select("id, name, dosage_mg, dosage_display, display_order")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("display_order"),
    admin
      .from("product_ingredient_research")
      .select(
        "id, ingredient_id, benefit_headline, mechanism_explanation, clinically_studied_benefits, dosage_comparison, citations, contraindications, ai_confidence, researched_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId),
    admin
      .from("product_review_analysis")
      .select(
        "top_benefits, before_after_pain_points, skeptic_conversions, surprise_benefits, most_powerful_phrases, reviews_analyzed_count, analyzed_at",
      )
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .maybeSingle(),
    admin
      .from("product_benefit_selections")
      .select(
        "id, benefit_name, role, display_order, science_confirmed, customer_confirmed, customer_phrases, customer_review_ids, ingredient_research_ids, ai_confidence, notes",
      )
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("display_order"),
    admin
      .from("product_page_content")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("product_media")
      .select("slot, url, alt_text, storage_path")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId),
  ]);

  if (productRes.error || !productRes.data) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const researchByIngredient = new Map<string, unknown[]>();
  for (const r of researchRes.data || []) {
    const list = researchByIngredient.get(r.ingredient_id) || [];
    list.push(r);
    researchByIngredient.set(r.ingredient_id, list);
  }

  const ingredients_with_research = (ingredientsRes.data || []).map((ing) => ({
    ...ing,
    research: researchByIngredient.get(ing.id) || [],
  }));

  const researchStatus =
    productRes.data.intelligence_status === "researching"
      ? "pending"
      : ingredients_with_research.every((i) => (i.research as unknown[]).length > 0) &&
        ingredients_with_research.length > 0
        ? "complete"
        : ingredients_with_research.some((i) => (i.research as unknown[]).length > 0)
          ? "partial"
          : "pending";

  return NextResponse.json({
    product: productRes.data,
    ingredients: ingredientsRes.data || [],
    research: { status: researchStatus, ingredients_with_research },
    review_analysis: analysisRes.data || null,
    benefit_selections: selectionsRes.data || [],
    page_content: contentRes.data || null,
    media: mediaRes.data || [],
  });
}
