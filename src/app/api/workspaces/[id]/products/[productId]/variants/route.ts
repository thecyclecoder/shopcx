import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyOnHandByVariant } from "@/lib/inventory/read";

/**
 * GET: list product_variants rows for a product, ordered by position.
 * Source of truth for variant metadata; the products.variants JSONB is a
 * legacy mirror. On-hand (`inventory_quantity`) is joined from the canonical
 * inventory_levels table — never the stale product_variants scalar.
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

  const [{ data, error }, onHand] = await Promise.all([
    admin
      .from("product_variants")
      .select("id, shopify_variant_id, sku, title, option1, option2, option3, price_cents, compare_at_price_cents, image_url, position, available")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("position", { ascending: true }),
    getShopifyOnHandByVariant(admin, workspaceId),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Canonical on-hand joined by Shopify variant id (single source of truth).
  const variants = (data || []).map((v) => ({
    ...v,
    inventory_quantity: v.shopify_variant_id != null ? onHand.get(String(v.shopify_variant_id)) ?? null : null,
  }));
  return NextResponse.json({ variants });
}
