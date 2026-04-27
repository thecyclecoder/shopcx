import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET: list product_variants rows for a product, ordered by position.
 * Source of truth for variant data; the products.variants JSONB is a
 * legacy mirror.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await admin
    .from("product_variants")
    .select("id, shopify_variant_id, sku, title, option1, option2, option3, price_cents, compare_at_price_cents, image_url, position, inventory_quantity, available")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("position", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ variants: data || [] });
}
