import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createOffer,
  listOffersForWorkspace,
  normalizeIncluded,
  normalizeScope,
} from "@/lib/offers";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const offers = await listOffersForWorkspace(workspaceId);

  const { data: products } = await admin
    .from("products")
    .select("id, title, image_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  const productIds = (products || []).map((p) => p.id);
  const { data: variants } = productIds.length
    ? await admin
        .from("product_variants")
        .select("id, product_id, title, sku, price_cents, image_url, position")
        .in("product_id", productIds)
        .order("position", { ascending: true })
    : { data: [] };

  const { data: digitalGoods } = await admin
    .from("digital_goods")
    .select("id, name, type")
    .eq("workspace_id", workspaceId);

  return NextResponse.json({
    offers,
    products: products || [],
    variants: variants || [],
    digital_goods: digitalGoods || [],
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

  const { user } = await getAuthedUser();
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
  const variantId = typeof body.variant_id === "string" ? body.variant_id : "";
  if (!variantId) {
    return NextResponse.json({ error: "variant_id required" }, { status: 400 });
  }

  try {
    const offer = await createOffer(workspaceId, {
      variant_id: variantId,
      name: typeof body.name === "string" ? body.name : null,
      included: normalizeIncluded(body.included),
      scope: normalizeScope(body.scope),
      overrides_pricing_rule_gifts: Boolean(body.overrides_pricing_rule_gifts),
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
    });
    return NextResponse.json({ offer });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
