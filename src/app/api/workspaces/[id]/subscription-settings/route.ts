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
  const { data: ws } = await admin.from("workspaces")
    .select("subscription_discount_pct, subscription_frequencies, subscription_free_shipping, subscription_free_shipping_threshold_cents, subscription_free_gift_variant_id, subscription_free_gift_product_title, subscription_free_gift_image_url")
    .eq("id", workspaceId)
    .single();

  if (!ws) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    discount_pct: ws.subscription_discount_pct ?? 25,
    frequencies: ws.subscription_frequencies || [{ value: 1, unit: "months" }],
    free_shipping: ws.subscription_free_shipping ?? false,
    free_shipping_threshold_cents: ws.subscription_free_shipping_threshold_cents,
    free_gift_variant_id: ws.subscription_free_gift_variant_id,
    free_gift_product_title: ws.subscription_free_gift_product_title,
    free_gift_image_url: ws.subscription_free_gift_image_url,
  });
}

export async function PATCH(
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};

  if (typeof body.discount_pct === "number") {
    updates.subscription_discount_pct = Math.max(0, Math.min(100, body.discount_pct));
  }
  if (Array.isArray(body.frequencies)) {
    updates.subscription_frequencies = body.frequencies.filter(
      (f: { value?: number; unit?: string }) => typeof f?.value === "number" && typeof f?.unit === "string"
    );
  }
  if (typeof body.free_shipping === "boolean") {
    updates.subscription_free_shipping = body.free_shipping;
  }
  if ("free_shipping_threshold_cents" in body) {
    updates.subscription_free_shipping_threshold_cents = body.free_shipping_threshold_cents;
  }
  if ("free_gift_variant_id" in body) {
    updates.subscription_free_gift_variant_id = body.free_gift_variant_id || null;
  }
  if ("free_gift_product_title" in body) {
    updates.subscription_free_gift_product_title = body.free_gift_product_title || null;
  }
  if ("free_gift_image_url" in body) {
    updates.subscription_free_gift_image_url = body.free_gift_image_url || null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { error } = await admin.from("workspaces").update(updates).eq("id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
