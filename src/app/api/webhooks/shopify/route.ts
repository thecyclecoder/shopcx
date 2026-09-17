import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  verifyShopifyWebhook,
  handleCustomerUpdate,
  handleOrderEvent,
  handleDisputeEvent,
  handleFulfillmentUpdate,
  handleRefundCreate,
} from "@/lib/shopify-webhooks";
import { handlePaymentMethodEvent } from "@/lib/dunning-webhook";
import { handleBillingAttemptEvent } from "@/lib/shopify-billing-attempt-webhook";
import { sendShopifyPurchase } from "@/lib/meta-capi-shopify-purchase";
import { inngest } from "@/lib/inngest/client";
import {
  CONTRACT_CREATED_EVENT,
  CONTRACT_UPDATED_EVENT,
} from "@/lib/inngest/shopcx-contract-ingest";

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
        await handleOrderEvent(workspace.id, payload);
        // Meta CAPI Purchase — new web checkouts ONLY (renewals are filtered
        // inside). Fires on create, never on update, so a later edit to the
        // order can't emit a second conversion. Deduped against the web pixel's
        // browser Purchase on `shopify_purchase_{orderId}`. Never throws.
        await sendShopifyPurchase(workspace.id, payload);
        break;

      case "orders/updated":
        await handleOrderEvent(workspace.id, payload);
        break;

      case "fulfillments/update":
        await handleFulfillmentUpdate(workspace.id, payload);
        break;

      case "refunds/create":
        // Vendor-side refund mirror. A refund fired in the Shopify admin
        // (or by any path that does not call refundOrder) writes NOTHING
        // to order_refunds without this handler; the double-refund guard
        // is blind on those orders. See src/lib/vendor-refund-mirror.ts.
        await handleRefundCreate(workspace.id, payload);
        break;

      case "disputes/create":
      case "disputes/update":
        await handleDisputeEvent(workspace.id, payload, topic);
        break;

      case "customer_payment_methods/create":
      case "customer_payment_methods/update":
        await handlePaymentMethodEvent(workspace.id, payload);
        break;

      case "subscription_billing_attempts/success":
      case "subscription_billing_attempts/failure":
      case "subscription_billing_attempts/challenged":
        // RECORDS ONLY — does not drive dunning. Appstle still relays failures, and
        // double-triggering would re-dun customers already in a cycle. See
        // src/lib/shopify-billing-attempt-webhook.ts.
        await handleBillingAttemptEvent(workspace.id, payload, topic);
        break;

      case "subscription_contracts/create":
      case "subscription_contracts/update": {
        // ⭐ A PDP checkout with a selling plan creates a real contract our app owns. Until this
        // case existed the topic fell through to the no-op below, so the customer had a live
        // Shopify subscription and NO ShopCX row — no portal, no renewal, no analytics. Shopify
        // charges nothing on its own, so that is a subscriber who would never be billed.
        //
        // Handed to Inngest rather than done here: ingestion has to wait out a race against our
        // own contract-creating rails (migration, one-time charges), and a webhook is the wrong
        // place to sleep. See src/lib/inngest/shopcx-contract-ingest.ts.
        const contractId = String(
          payload.admin_graphql_api_id ?? payload.id ?? "",
        ).replace("gid://shopify/SubscriptionContract/", "");
        if (!contractId) {
          console.error(`Shopify ${topic} with no contract id in payload`);
          break;
        }
        await inngest.send({
          name: topic === "subscription_contracts/create" ? CONTRACT_CREATED_EVENT : CONTRACT_UPDATED_EVENT,
          data: { workspaceId: workspace.id, contractId },
        });
        break;
      }

      default:
        console.log(`Unhandled Shopify webhook topic: ${topic}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`Shopify webhook error (${topic}):`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
