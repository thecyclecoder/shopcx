import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

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
      fulfillment_status, delivery_status, delivered_at, line_items, created_at, tags, source_name,
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

  // Delivery status events
  if (order.delivered_at) {
    timeline.push({
      timestamp: order.delivered_at,
      event: "Delivered",
      detail: order.delivery_status === "returned" ? "Returned to sender" : undefined,
    });
  } else if (order.delivery_status === "returned" && order.sync_resolved_at) {
    timeline.push({
      timestamp: order.sync_resolved_at,
      event: "Returned to sender",
      detail: order.sync_resolved_note || undefined,
    });
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
    // Get the order's Shopify ID
    const { data: order } = await admin
      .from("orders")
      .select("shopify_order_id")
      .eq("id", orderId)
      .eq("workspace_id", workspaceId)
      .single();

    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

    // Mark fulfilled in Shopify (no customer notification)
    const { data: ws } = await admin
      .from("workspaces")
      .select("shopify_access_token_encrypted, shopify_myshopify_domain")
      .eq("id", workspaceId)
      .single();

    if (ws?.shopify_access_token_encrypted && ws?.shopify_myshopify_domain) {
      const accessToken = decrypt(ws.shopify_access_token_encrypted);
      const shopifyGid = `gid://shopify/Order/${order.shopify_order_id}`;

      // Step 1: Get fulfillment orders for this order
      const foQuery = `{ order(id: "${shopifyGid}") { fulfillmentOrders(first: 5) { edges { node { id status } } } } }`;
      const foRes = await fetch(`https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query: foQuery }),
      });
      const foData = await foRes.json();
      const fulfillmentOrders = foData.data?.order?.fulfillmentOrders?.edges || [];

      // Step 2: Fulfill each open fulfillment order without notifying customer
      for (const edge of fulfillmentOrders) {
        const fo = edge.node;
        if (fo.status === "CLOSED" || fo.status === "CANCELLED") continue;

        const fulfillMutation = `
          mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
            fulfillmentCreateV2(fulfillment: $fulfillment) {
              fulfillment { id }
              userErrors { field message }
            }
          }
        `;

        await fetch(`https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: fulfillMutation,
            variables: {
              fulfillment: {
                lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
                notifyCustomer: false,
              },
            },
          }),
        });
      }
    }

    // Update our DB
    const { error } = await admin
      .from("orders")
      .update({
        sync_resolved_at: new Date().toISOString(),
        sync_resolved_note: body.note || null,
        fulfillment_status: "fulfilled",
      })
      .eq("id", orderId)
      .eq("workspace_id", workspaceId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
