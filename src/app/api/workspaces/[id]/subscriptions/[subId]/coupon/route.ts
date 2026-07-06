import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCustomerEvent } from "@/lib/customer-events";
import { subscriptionApplyCoupon, subscriptionRemoveCoupon } from "@/lib/subscription-items";

// POST: Apply coupon
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId).eq("workspace_id", workspaceId).single();
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { couponCode } = await request.json();
  if (!couponCode) return NextResponse.json({ error: "couponCode required" }, { status: 400 });

  const result = await subscriptionApplyCoupon(workspaceId, String(sub.shopify_contract_id), couponCode);
  if (!result.success) {
    return NextResponse.json({ error: result.error || "Failed to apply coupon" }, { status: 500 });
  }

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.coupon_applied", source: "agent",
      summary: `Coupon "${couponCode}" applied to subscription`,
      properties: { shopify_contract_id: sub.shopify_contract_id, couponCode },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE: Remove coupon
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; subId: string }> }
) {
  const { id: workspaceId, subId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: sub } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, customer_id")
    .eq("id", subId).eq("workspace_id", workspaceId).single();
  if (!sub) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { discountId } = await request.json();
  if (!discountId) return NextResponse.json({ error: "discountId required" }, { status: 400 });

  const result = await subscriptionRemoveCoupon(workspaceId, String(sub.shopify_contract_id), discountId);
  if (!result.success) {
    return NextResponse.json({ error: result.error || "Failed to remove coupon" }, { status: 500 });
  }

  if (sub.customer_id) {
    await logCustomerEvent({
      workspaceId, customerId: sub.customer_id,
      eventType: "subscription.coupon_removed", source: "agent",
      summary: "Coupon removed from subscription",
      properties: { shopify_contract_id: sub.shopify_contract_id, discountId },
    });
  }

  return NextResponse.json({ ok: true });
}
