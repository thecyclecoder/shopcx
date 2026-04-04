import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyShopifyWebhook } from "@/lib/shopify-webhooks";
import { inngest } from "@/lib/inngest/client";

export async function POST(request: Request) {
  const body = await request.text();
  const topic = request.headers.get("x-shopify-topic");
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const hmac = request.headers.get("x-shopify-hmac-sha256");

  if (!topic || !shopDomain || !hmac) {
    return NextResponse.json({ error: "Missing headers" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("shopify_myshopify_domain", shopDomain)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Unknown shop" }, { status: 404 });
  }

  const valid = await verifyShopifyWebhook(body, hmac, workspace.id);
  if (!valid) {
    console.error(`Shopify returns webhook HMAC failed for topic=${topic} shop=${shopDomain}`);
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  console.log(`Shopify returns webhook received: topic=${topic} shop=${shopDomain}`);

  const payload = JSON.parse(body);

  try {
    switch (topic) {
      case "returns/request":
        await handleReturnRequest(admin, workspace.id, payload);
        break;

      case "returns/approve":
        await handleReturnApprove(admin, workspace.id, payload);
        break;

      case "returns/update":
        await handleReturnUpdate(admin, workspace.id, payload);
        break;

      case "returns/close":
        await handleReturnClose(admin, workspace.id, payload);
        break;

      case "returns/process":
        await handleReturnProcess(admin, workspace.id, payload);
        break;

      case "reverse_fulfillment_orders/dispose":
        await handleDispose(admin, workspace.id, payload);
        break;

      default:
        console.log(`Unhandled returns webhook topic: ${topic}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`Shopify returns webhook error (${topic}):`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

type Admin = ReturnType<typeof createAdminClient>;

// returns/request — customer-initiated return request via Shopify self-serve
async function handleReturnRequest(
  admin: Admin,
  workspaceId: string,
  payload: { id: number; order_id: number; admin_graphql_api_id: string; status: string },
) {
  const shopifyReturnGid = payload.admin_graphql_api_id;

  // Check if we already track this return
  const { data: existing } = await admin
    .from("returns")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid)
    .single();

  if (existing) return; // Already tracked

  // Look up the order in our DB
  const shopifyOrderGid = `gid://shopify/Order/${payload.order_id}`;
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, customer_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_order_id", String(payload.order_id))
    .single();

  const orderNumber = order?.order_number || `#${payload.order_id}`;

  const { data: returnRow } = await admin
    .from("returns")
    .insert({
      workspace_id: workspaceId,
      order_id: order?.id || null,
      order_number: orderNumber,
      shopify_order_gid: shopifyOrderGid,
      customer_id: order?.customer_id || null,
      shopify_return_gid: shopifyReturnGid,
      status: "pending",
      resolution_type: "refund_return",
      source: "shopify",
    })
    .select("id")
    .single();

  // Create dashboard notification
  if (returnRow) {
    await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: "return_request",
      title: "Return Request",
      body: `Customer requested a return for order ${orderNumber}`,
      link: `/dashboard/returns/${returnRow.id}`,
    });
  }
}

// returns/approve — upsert if not already tracked (Shopify-initiated returns)
async function handleReturnApprove(
  admin: Admin,
  workspaceId: string,
  payload: { id: number; order_id: number; admin_graphql_api_id: string; status: string },
) {
  const shopifyReturnGid = payload.admin_graphql_api_id;

  // Check if we already track this return
  const { data: existing } = await admin
    .from("returns")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid)
    .single();

  if (existing) return; // Already tracked

  // Look up the order in our DB
  const shopifyOrderGid = `gid://shopify/Order/${payload.order_id}`;
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, customer_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_order_id", String(payload.order_id))
    .single();

  await admin.from("returns").insert({
    workspace_id: workspaceId,
    order_id: order?.id || null,
    order_number: order?.order_number || `#${payload.order_id}`,
    shopify_order_gid: shopifyOrderGid,
    customer_id: order?.customer_id || null,
    shopify_return_gid: shopifyReturnGid,
    status: "open",
    resolution_type: "refund_return", // Default for Shopify-initiated
    source: "shopify",
  });
}

// returns/update — sync status
async function handleReturnUpdate(
  admin: Admin,
  workspaceId: string,
  payload: { admin_graphql_api_id: string; status: string },
) {
  const shopifyReturnGid = payload.admin_graphql_api_id;
  const statusMap: Record<string, string> = {
    OPEN: "open",
    CLOSED: "closed",
    CANCELED: "cancelled",
    REQUESTED: "pending",
    DECLINED: "cancelled",
  };

  const newStatus = statusMap[payload.status] || "open";

  await admin
    .from("returns")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid);
}

// returns/close
async function handleReturnClose(
  admin: Admin,
  workspaceId: string,
  payload: { admin_graphql_api_id: string },
) {
  await admin
    .from("returns")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", payload.admin_graphql_api_id);
}

// returns/process — mark as refunded
async function handleReturnProcess(
  admin: Admin,
  workspaceId: string,
  payload: { admin_graphql_api_id: string },
) {
  await admin
    .from("returns")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", payload.admin_graphql_api_id);
}

// reverse_fulfillment_orders/dispose — mark restocked, trigger refund flow
async function handleDispose(
  admin: Admin,
  workspaceId: string,
  payload: { admin_graphql_api_id: string },
) {
  const rfoGid = payload.admin_graphql_api_id;

  const { data: ret } = await admin
    .from("returns")
    .select("id, resolution_type")
    .eq("workspace_id", workspaceId)
    .eq("shopify_reverse_fulfillment_order_gid", rfoGid)
    .single();

  if (!ret) return;

  await admin
    .from("returns")
    .update({
      status: "restocked",
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", ret.id);

  // Trigger refund flow
  await inngest.send({
    name: "returns/issue-refund",
    data: { workspace_id: workspaceId, return_id: ret.id },
  });
}
