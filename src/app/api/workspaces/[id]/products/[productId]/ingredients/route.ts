import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

function slotForIngredient(name: string): string {
  return `ingredient_${name.toLowerCase().trim().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "")}`;
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
  const { data } = await admin
    .from("product_ingredients")
    .select("id, name, dosage_mg, dosage_display, display_order")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("display_order");

  return NextResponse.json({ ingredients: data || [] });
}

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
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });

  // Determine next display_order
  const { data: existing } = await admin
    .from("product_ingredients")
    .select("display_order")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("display_order", { ascending: false })
    .limit(1);

  const nextOrder = (existing?.[0]?.display_order ?? -1) + 1;

  const { data: ingredient, error } = await admin
    .from("product_ingredients")
    .insert({
      workspace_id: workspaceId,
      product_id: productId,
      name,
      dosage_mg: typeof body.dosage_mg === "number" ? body.dosage_mg : null,
      dosage_display: typeof body.dosage_display === "string" ? body.dosage_display : null,
      display_order: nextOrder,
    })
    .select("id, name, dosage_mg, dosage_display, display_order")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auto-create product_media row for this ingredient's image slot
  await admin.from("product_media").upsert(
    {
      workspace_id: workspaceId,
      product_id: productId,
      slot: slotForIngredient(name),
    },
    { onConflict: "workspace_id,product_id,slot" },
  );

  // Update intelligence_status if still 'none'
  await admin
    .from("products")
    .update({ intelligence_status: "ingredients_added" })
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .eq("intelligence_status", "none");

  return NextResponse.json({ ingredient });
}
