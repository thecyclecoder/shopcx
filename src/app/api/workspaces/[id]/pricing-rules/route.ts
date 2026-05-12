import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: rules } = await admin.from("pricing_rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  // Get product assignments for each rule
  const { data: assignments } = await admin.from("product_pricing_rule")
    .select("product_id, pricing_rule_id")
    .eq("workspace_id", workspaceId);

  const { data: products } = await admin.from("products")
    .select("id, title, image_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  // Variants for the free-gift picker. Joined client-side by product
  // id; we ship a flat list with parent product info embedded so the
  // dashboard can render "Product — Variant" rows in one pass.
  const productIds = (products || []).map((p) => p.id);
  const { data: variants } = productIds.length
    ? await admin
        .from("product_variants")
        .select("id, product_id, shopify_variant_id, title, sku, price_cents, image_url, position")
        .in("product_id", productIds)
        .order("position", { ascending: true })
    : { data: [] };

  const assignmentMap = new Map<string, string[]>();
  for (const a of assignments || []) {
    const list = assignmentMap.get(a.pricing_rule_id) || [];
    list.push(a.product_id);
    assignmentMap.set(a.pricing_rule_id, list);
  }

  const enrichedRules = (rules || []).map(r => ({
    ...r,
    product_ids: assignmentMap.get(r.id) || [],
  }));

  return NextResponse.json({
    rules: enrichedRules,
    products: products || [],
    variants: variants || [],
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  const { data, error } = await admin.from("pricing_rules").insert({
    workspace_id: workspaceId,
    name: body.name || "New Pricing Rule",
    quantity_breaks: body.quantity_breaks || [],
    free_shipping: body.free_shipping || false,
    free_shipping_threshold_cents: body.free_shipping_threshold_cents || null,
    free_shipping_subscription_only: body.free_shipping_subscription_only || false,
    free_gift_variant_id: body.free_gift_variant_id || null,
    free_gift_product_title: body.free_gift_product_title || null,
    free_gift_image_url: body.free_gift_image_url || null,
    free_gift_min_quantity: body.free_gift_min_quantity || 1,
    free_gift_subscription_only: body.free_gift_subscription_only || false,
    subscribe_discount_pct: body.subscribe_discount_pct || 0,
    available_frequencies: body.available_frequencies || [],
    is_active: true,
  }).select("*").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Assign products if provided
  if (Array.isArray(body.product_ids) && body.product_ids.length > 0) {
    // Remove existing assignments for these products (one rule per product)
    await admin.from("product_pricing_rule")
      .delete()
      .eq("workspace_id", workspaceId)
      .in("product_id", body.product_ids);

    await admin.from("product_pricing_rule").insert(
      body.product_ids.map((pid: string) => ({
        workspace_id: workspaceId,
        product_id: pid,
        pricing_rule_id: data.id,
      }))
    );
  }

  return NextResponse.json({ rule: data });
}
