import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const { id: workspaceId, ruleId } = await params;

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
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string") updates.name = body.name;
  if (Array.isArray(body.quantity_breaks)) updates.quantity_breaks = body.quantity_breaks;
  if (typeof body.free_shipping === "boolean") updates.free_shipping = body.free_shipping;
  if ("free_shipping_threshold_cents" in body) updates.free_shipping_threshold_cents = body.free_shipping_threshold_cents;
  if ("free_gift_variant_id" in body) updates.free_gift_variant_id = body.free_gift_variant_id;
  if ("free_gift_product_title" in body) updates.free_gift_product_title = body.free_gift_product_title;
  if ("free_gift_image_url" in body) updates.free_gift_image_url = body.free_gift_image_url;
  if (typeof body.free_gift_min_quantity === "number") updates.free_gift_min_quantity = body.free_gift_min_quantity;
  if (typeof body.is_active === "boolean") updates.is_active = body.is_active;
  if (typeof body.subscribe_discount_pct === "number") updates.subscribe_discount_pct = body.subscribe_discount_pct;
  if (Array.isArray(body.available_frequencies)) updates.available_frequencies = body.available_frequencies;
  if (typeof body.free_shipping_subscription_only === "boolean") updates.free_shipping_subscription_only = body.free_shipping_subscription_only;
  if (typeof body.free_gift_subscription_only === "boolean") updates.free_gift_subscription_only = body.free_gift_subscription_only;

  const { error } = await admin.from("pricing_rules")
    .update(updates)
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Update product assignments if provided
  if (Array.isArray(body.product_ids)) {
    // Remove all current assignments for this rule
    await admin.from("product_pricing_rule")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("pricing_rule_id", ruleId);

    if (body.product_ids.length > 0) {
      // Remove any other rule assignments for these products (one rule per product)
      await admin.from("product_pricing_rule")
        .delete()
        .eq("workspace_id", workspaceId)
        .in("product_id", body.product_ids);

      await admin.from("product_pricing_rule").insert(
        body.product_ids.map((pid: string) => ({
          workspace_id: workspaceId,
          product_id: pid,
          pricing_rule_id: ruleId,
        }))
      );
    }
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const { id: workspaceId, ruleId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Cascade: product assignments deleted via FK ON DELETE CASCADE
  await admin.from("pricing_rules").delete().eq("id", ruleId).eq("workspace_id", workspaceId);

  return NextResponse.json({ success: true });
}
