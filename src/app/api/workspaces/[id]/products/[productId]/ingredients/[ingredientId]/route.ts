import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function slotForIngredient(name: string): string {
  return `ingredient_${name.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}`;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; ingredientId: string }> },
) {
  const { id: workspaceId, productId, ingredientId } = await params;

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
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if ("dosage_mg" in body) update.dosage_mg = typeof body.dosage_mg === "number" ? body.dosage_mg : null;
  if ("dosage_display" in body) {
    update.dosage_display = typeof body.dosage_display === "string" ? body.dosage_display : null;
  }
  if (typeof body.display_order === "number") update.display_order = body.display_order;

  const { data, error } = await admin
    .from("product_ingredients")
    .update(update)
    .eq("id", ingredientId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .select("id, name, dosage_mg, dosage_display, display_order")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ingredient: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; ingredientId: string }> },
) {
  const { id: workspaceId, productId, ingredientId } = await params;
  void request;

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

  // Get ingredient name to derive slot before delete
  const { data: ingredient } = await admin
    .from("product_ingredients")
    .select("name")
    .eq("id", ingredientId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .single();

  // Cascade deletes product_ingredient_research automatically (FK ON DELETE CASCADE)
  const { error } = await admin
    .from("product_ingredients")
    .delete()
    .eq("id", ingredientId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (ingredient?.name) {
    await admin
      .from("product_media")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .eq("slot", slotForIngredient(ingredient.name));
  }

  return NextResponse.json({ success: true });
}
