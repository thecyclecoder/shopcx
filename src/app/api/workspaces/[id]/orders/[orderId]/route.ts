import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> }
) {
  const { id: workspaceId, orderId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select(`
      id, order_number, email, total_cents, currency, financial_status,
      fulfillment_status, line_items, created_at, tags, source_name,
      shopify_order_id, shopify_customer_id, subscription_id,
      shipping_address, discount_codes, order_type,
      amplifier_order_id, amplifier_received_at, amplifier_shipped_at,
      amplifier_tracking_number, amplifier_carrier, amplifier_status,
      sync_resolved_at, sync_resolved_note,
      fulfillments,
      customer_id,
      customers(id, email, first_name, last_name, phone, shopify_customer_id, retention_score, ltv_cents, total_orders)
    `)
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .single();

  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get workspace for Shopify domain
  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  // Get subscription info if linked
  let subscription = null;
  if (order.subscription_id) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status, billing_interval, billing_interval_count, next_billing_date")
      .eq("id", order.subscription_id)
      .single();
    subscription = sub;
  }

  // Build timeline
  const timeline: { timestamp: string; event: string; detail?: string }[] = [];

  timeline.push({
    timestamp: order.created_at,
    event: "Order created",
    detail: `${order.order_number} — $${(order.total_cents / 100).toFixed(2)}${order.source_name ? ` via ${order.source_name}` : ""}`,
  });

  if (order.amplifier_received_at) {
    timeline.push({
      timestamp: order.amplifier_received_at,
      event: "Received by Amplifier",
      detail: order.amplifier_status || "Processing",
    });
  }

  if (order.amplifier_shipped_at) {
    timeline.push({
      timestamp: order.amplifier_shipped_at,
      event: "Shipped",
      detail: [order.amplifier_carrier, order.amplifier_tracking_number].filter(Boolean).join(" — ") || undefined,
    });
  }

  // Add fulfillment events from Shopify
  const fulfillments = (order.fulfillments as { status?: string; createdAt?: string; trackingInfo?: { number?: string; company?: string; url?: string }[] }[]) || [];
  for (const f of fulfillments) {
    if (f.createdAt) {
      const tracking = f.trackingInfo?.[0];
      timeline.push({
        timestamp: f.createdAt,
        event: `Fulfillment ${f.status || "updated"}`,
        detail: tracking ? `${tracking.company || ""} ${tracking.number || ""}`.trim() : undefined,
      });
    }
  }

  if (order.financial_status === "refunded" || order.financial_status === "partially_refunded") {
    // We don't have the exact refund timestamp, use a marker
    timeline.push({
      timestamp: order.created_at, // approximate
      event: order.financial_status === "refunded" ? "Fully refunded" : "Partially refunded",
    });
  }

  // Sort timeline chronologically
  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return NextResponse.json({
    order,
    subscription,
    shopify_domain: workspace?.shopify_myshopify_domain || "",
    timeline,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> }
) {
  const { id: workspaceId, orderId } = await params;

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

  const body = await request.json();

  if (body.action === "resolve_sync") {
    const { error } = await admin
      .from("orders")
      .update({
        sync_resolved_at: new Date().toISOString(),
        sync_resolved_note: body.note || null,
      })
      .eq("id", orderId)
      .eq("workspace_id", workspaceId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
