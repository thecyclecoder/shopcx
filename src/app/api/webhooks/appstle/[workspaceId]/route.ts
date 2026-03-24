import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { Webhook } from "svix";
import { calculateRetentionScore } from "@/lib/retention-score";

function mapStatus(status: string): "active" | "paused" | "cancelled" | "expired" | "failed" {
  switch (status?.toUpperCase()) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    case "CANCELLED": return "cancelled";
    case "EXPIRED": return "expired";
    case "FAILED": return "failed";
    default: return "active";
  }
}

function mapCustomerStatus(status: string): "active" | "paused" | "cancelled" | "never" {
  switch (status?.toUpperCase()) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    default: return "cancelled";
  }
}

function extractId(gid: string): string {
  return String(gid).split("/").pop() || String(gid);
}

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const body = await request.text();
  const headers = {
    "svix-id": request.headers.get("svix-id") || "",
    "svix-timestamp": request.headers.get("svix-timestamp") || "",
    "svix-signature": request.headers.get("svix-signature") || "",
  };

  if (!headers["svix-id"] || !headers["svix-signature"]) {
    return NextResponse.json({ error: "Missing Svix headers" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up this specific workspace's secret
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, appstle_webhook_secret_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.appstle_webhook_secret_encrypted) {
    return NextResponse.json({ error: "Appstle not configured for this workspace" }, { status: 404 });
  }

  // Verify signature
  let payload: Record<string, unknown>;
  try {
    const secret = decrypt(workspace.appstle_webhook_secret_encrypted);
    const wh = new Webhook(secret);
    payload = wh.verify(body, headers) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventType = payload.type as string;
  const data = payload.data as Record<string, unknown>;

  if (!data || !eventType) {
    return NextResponse.json({ ok: true });
  }

  console.log(`Appstle webhook: ${eventType}`);

  try {
    // Rich subscription events have data.customer
    // Flat billing events have data.contractId without data.customer
    if (data.customer) {
      await handleSubscriptionEvent(admin, workspaceId, eventType, data);
    } else if (data.contractId) {
      await handleBillingEvent(admin, workspaceId, eventType, data);
    }

    return NextResponse.json({ ok: true, event: eventType });
  } catch (err) {
    console.error(`Appstle webhook error (${eventType}):`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

async function handleSubscriptionEvent(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  eventType: string,
  data: Record<string, unknown>,
) {
  const customer = data.customer as { id?: string; email?: string; firstName?: string; lastName?: string; phone?: string };
  if (!customer?.email) return;

  const shopifyCustomerId = customer.id ? extractId(customer.id) : null;
  const email = customer.email.toLowerCase();
  const contractId = data.id ? extractId(data.id as string) : null;
  const status = data.status as string;

  // Find or create customer
  let dbCustomer: { id: string } | null = null;

  if (shopifyCustomerId) {
    const { data: found } = await admin.from("customers").select("id")
      .eq("workspace_id", workspaceId).eq("shopify_customer_id", shopifyCustomerId).single();
    dbCustomer = found;
  }
  if (!dbCustomer) {
    const { data: found } = await admin.from("customers").select("id")
      .eq("workspace_id", workspaceId).eq("email", email).single();
    dbCustomer = found;
  }
  if (!dbCustomer) {
    const { data: created } = await admin.from("customers").insert({
      workspace_id: workspaceId, email,
      first_name: customer.firstName || null, last_name: customer.lastName || null,
      phone: customer.phone || null, shopify_customer_id: shopifyCustomerId,
    }).select("id").single();
    dbCustomer = created;
  }
  if (!dbCustomer) return;

  // Extract subscription items
  const lines = (data.lines as { nodes?: Record<string, unknown>[] })?.nodes || [];
  const items = lines.map((line) => ({
    title: line.title,
    sku: line.sku,
    quantity: line.quantity,
    price_cents: dollarsToCents((line.currentPrice as { amount?: string })?.amount),
    product_id: line.productId ? extractId(line.productId as string) : null,
    variant_title: line.variantTitle || null,
    selling_plan: line.sellingPlanName || null,
  }));

  const billingPolicy = data.billingPolicy as { interval?: string; intervalCount?: number } | undefined;
  const deliveryPrice = data.deliveryPrice as { amount?: string } | undefined;

  // Upsert subscription
  if (contractId) {
    await admin.from("subscriptions").upsert({
      workspace_id: workspaceId,
      customer_id: dbCustomer.id,
      shopify_contract_id: contractId,
      shopify_customer_id: shopifyCustomerId,
      status: mapStatus(status),
      billing_interval: billingPolicy?.interval?.toLowerCase() || null,
      billing_interval_count: billingPolicy?.intervalCount || null,
      next_billing_date: (data.nextBillingDate as string) || null,
      last_payment_status: (data.lastPaymentStatus as string)?.toLowerCase() || null,
      items,
      delivery_price_cents: dollarsToCents(deliveryPrice?.amount),
      updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,shopify_contract_id" });
  }

  // Determine overall customer subscription status from all their subscriptions
  const { data: allSubs } = await admin.from("subscriptions").select("status").eq("customer_id", dbCustomer.id);
  const hasActive = allSubs?.some((s) => s.status === "active");
  const hasPaused = allSubs?.some((s) => s.status === "paused");
  const overallStatus = hasActive ? "active" : hasPaused ? "paused" : mapCustomerStatus(status);

  await admin.from("customers").update({
    subscription_status: overallStatus,
    updated_at: new Date().toISOString(),
  }).eq("id", dbCustomer.id);

  // Recalculate retention score
  const { data: full } = await admin.from("customers")
    .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
    .eq("id", dbCustomer.id).single();
  if (full) {
    await admin.from("customers").update({ retention_score: calculateRetentionScore(full) }).eq("id", dbCustomer.id);
  }
}

async function handleBillingEvent(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  eventType: string,
  data: Record<string, unknown>,
) {
  const contractId = String(data.contractId);

  const { data: sub } = await admin.from("subscriptions").select("id, customer_id")
    .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).single();

  if (!sub) {
    console.log(`Appstle billing: contract ${contractId} not found`);
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (eventType === "subscription.billing-failure") {
    updates.last_payment_status = "failed";
  } else if (eventType === "subscription.billing-success") {
    updates.last_payment_status = "succeeded";
  } else if (eventType === "subscription.billing-skipped") {
    updates.last_payment_status = "skipped";
  }

  await admin.from("subscriptions").update(updates).eq("id", sub.id);

  // Recalculate retention score on payment failures
  if (sub.customer_id && eventType !== "subscription.billing-success") {
    const { data: customer } = await admin.from("customers")
      .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
      .eq("id", sub.customer_id).single();
    if (customer) {
      await admin.from("customers").update({ retention_score: calculateRetentionScore(customer) }).eq("id", sub.customer_id);
    }
  }
}
