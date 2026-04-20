import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

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
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const ingredientIds = Array.isArray(body.ingredient_ids)
    ? (body.ingredient_ids.filter((i: unknown) => typeof i === "string") as string[])
    : undefined;

  await admin
    .from("products")
    .update({ intelligence_status: "researching" })
    .eq("id", productId)
    .eq("workspace_id", workspaceId);

  const { ids } = await inngest.send({
    name: "intelligence/research-ingredients",
    data: {
      workspace_id: workspaceId,
      product_id: productId,
      ingredient_ids: ingredientIds,
    },
  });

  return NextResponse.json({ event_id: ids?.[0] || null });
}

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

  const [{ data: product }, { data: ingredients }, { data: research }] = await Promise.all([
    admin
      .from("products")
      .select("intelligence_status")
      .eq("id", productId)
      .eq("workspace_id", workspaceId)
      .single(),
    admin
      .from("product_ingredients")
      .select("id, name, dosage_display, display_order")
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
  ]);

  const researchByIngredient = new Map<string, unknown[]>();
  for (const r of research || []) {
    const list = researchByIngredient.get(r.ingredient_id) || [];
    list.push(r);
    researchByIngredient.set(r.ingredient_id, list);
  }

  const ingredientsWithResearch = (ingredients || []).map((ing) => ({
    id: ing.id,
    name: ing.name,
    dosage_display: ing.dosage_display,
    research: researchByIngredient.get(ing.id) || [],
  }));

  const status =
    product?.intelligence_status === "researching"
      ? "pending"
      : ingredientsWithResearch.every((i) => (i.research as unknown[]).length > 0) && ingredientsWithResearch.length > 0
        ? "complete"
        : ingredientsWithResearch.some((i) => (i.research as unknown[]).length > 0)
          ? "partial"
          : "pending";

  return NextResponse.json({ status, ingredients: ingredientsWithResearch });
}
