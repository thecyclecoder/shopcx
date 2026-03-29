import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  verifyShopifyWebhook,
  handleCustomerUpdate,
  handleOrderEvent,
  handleDisputeEvent,
} from "@/lib/shopify-webhooks";
import { handlePaymentMethodEvent } from "@/lib/dunning-webhook";

export async function POST(request: Request) {
  const body = await request.text();
  const topic = request.headers.get("x-shopify-topic");
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const hmac = request.headers.get("x-shopify-hmac-sha256");

  if (!topic || !shopDomain || !hmac) {
    return NextResponse.json({ error: "Missing headers" }, { status: 400 });
  }

  // Look up workspace by myshopify_domain
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
    console.error(`Shopify webhook HMAC failed for topic=${topic} shop=${shopDomain}`);
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 401 });
  }

  console.log(`Shopify webhook received: topic=${topic} shop=${shopDomain}`);

  const payload = JSON.parse(body);

  try {
    switch (topic) {
      case "customers/create":
      case "customers/update":
        await handleCustomerUpdate(workspace.id, payload);
        break;

      case "orders/create":
      case "orders/updated":
        await handleOrderEvent(workspace.id, payload);
        break;

      case "disputes/create":
      case "disputes/update":
        await handleDisputeEvent(workspace.id, payload, topic);
        break;

      case "customer_payment_methods/create":
      case "customer_payment_methods/update":
        await handlePaymentMethodEvent(workspace.id, payload);
        break;

      default:
        console.log(`Unhandled Shopify webhook topic: ${topic}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`Shopify webhook error (${topic}):`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
