// Shopify Returns webhook handler
// Topics: returns/approve, returns/update, returns/close, returns/process, reverse_fulfillment_orders/dispose

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

  // Verify HMAC
  const valid = await verifyShopifyWebhook(body, hmac, workspace.id);
  if (!valid) {
    console.error(`Shopify returns webhook HMAC failed for topic=${topic} shop=${shopDomain}`);
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  console.log(`Shopify returns webhook: topic=${topic} shop=${shopDomain}`);

  const payload = JSON.parse(body);

  try {
    switch (topic) {
      case "returns/approve":
        await handleReturnApprove(workspace.id, payload);
        break;

      case "returns/update":
        await handleReturnUpdate(workspace.id, payload);
        break;

      case "returns/close":
        await handleReturnClose(workspace.id, payload);
        break;

      case "returns/process":
        await handleReturnProcess(workspace.id, payload);
        break;

      case "reverse_fulfillment_orders/dispose":
        await handleReverseDispose(workspace.id, payload);
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

// ── Handler functions ──

async function handleReturnApprove(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyReturnGid = `gid://shopify/Return/${payload.id}`;
  const orderGid = payload.order_id ? `gid://shopify/Order/${payload.order_id}` : null;

  // Check if we already track this return
  const { data: existing } = await admin
    .from("returns")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid)
    .single();

  if (existing) {
    // Already tracked — update status
    await admin
      .from("returns")
      .update({ status: "open", updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    return;
  }

  // Upsert: return created externally (e.g. from Shopify admin)
  if (!orderGid) return;

  // Look up order in our DB
  const shopifyOrderId = String(payload.order_id);
  const { data: order } = await admin
    .from("orders")
    .select("id, order_number, total_cents, customer_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_order_id", shopifyOrderId)
    .single();

  if (!order) {
    console.log(`Return approve: order ${shopifyOrderId} not found in DB`);
    return;
  }

  await admin.from("returns").insert({
    workspace_id: workspaceId,
    order_id: order.id,
    order_number: order.order_number || shopifyOrderId,
    shopify_order_gid: orderGid,
    customer_id: order.customer_id,
    shopify_return_gid: shopifyReturnGid,
    status: "open",
    resolution_type: "refund_return", // Default for externally created
    source: "shopify",
    order_total_cents: order.total_cents || 0,
    return_line_items: payload.return_line_items || [],
  });
}

async function handleReturnUpdate(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyReturnGid = `gid://shopify/Return/${payload.id}`;

  // Map Shopify status to our status
  const statusMap: Record<string, string> = {
    OPEN: "open",
    CLOSED: "closed",
    CANCELED: "cancelled",
    REQUESTED: "pending",
    DECLINED: "cancelled",
  };

  const shopifyStatus = payload.status as string;
  const ourStatus = statusMap[shopifyStatus] || "open";

  await admin
    .from("returns")
    .update({ status: ourStatus, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid);
}

async function handleReturnClose(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyReturnGid = `gid://shopify/Return/${payload.id}`;

  await admin
    .from("returns")
    .update({ status: "closed", updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid);
}

async function handleReturnProcess(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyReturnGid = `gid://shopify/Return/${payload.id}`;

  await admin
    .from("returns")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("shopify_return_gid", shopifyReturnGid);
}

async function handleReverseDispose(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const rfoGid = `gid://shopify/ReverseFulfillmentOrder/${payload.id}`;

  // Find the return by reverse fulfillment order GID
  const { data: returnRow } = await admin
    .from("returns")
    .select("id, workspace_id, status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_reverse_fulfillment_order_gid", rfoGid)
    .single();

  if (!returnRow) {
    console.log(`Reverse dispose: RFO ${rfoGid} not tracked`);
    return;
  }

  // Update status to restocked
  await admin
    .from("returns")
    .update({
      status: "restocked",
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", returnRow.id);

  // Trigger refund flow via Inngest
  await inngest.send({
    name: "returns/issue-refund",
    data: {
      workspace_id: workspaceId,
      return_id: returnRow.id,
    },
  });
}
