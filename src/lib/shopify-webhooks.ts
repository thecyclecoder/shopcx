import { createHmac } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { calculateRetentionScore } from "@/lib/retention-score";

// ── HMAC verification ──

export async function verifyShopifyWebhook(
  body: string,
  hmacHeader: string,
  workspaceId: string
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_client_secret_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.shopify_client_secret_encrypted) return false;

  const secret = decrypt(workspace.shopify_client_secret_encrypted);
  const computed = createHmac("sha256", secret).update(body, "utf8").digest("base64");

  // Timing-safe comparison
  if (computed.length !== hmacHeader.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  }
  return result === 0;
}

// ── Helpers ──

function dollarsToCents(amount: string | number | null | undefined): number {
  if (amount == null) return 0;
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

// ── Customer update handler ──

export async function handleCustomerUpdate(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyCustomerId = String(payload.id);
  const email = ((payload.email as string) || "").toLowerCase();

  // Upsert customer
  const record = {
    workspace_id: workspaceId,
    shopify_customer_id: shopifyCustomerId,
    email: email || `no-email-${shopifyCustomerId}@unknown.com`,
    first_name: (payload.first_name as string) || null,
    last_name: (payload.last_name as string) || null,
    phone: (payload.phone as string) || null,
    total_orders: (payload.orders_count as number) ?? 0,
    ltv_cents: dollarsToCents(payload.total_spent as string),
    tags: payload.tags ? (payload.tags as string).split(", ").filter(Boolean) : [],
    updated_at: new Date().toISOString(),
  };

  const { data: customer } = await admin
    .from("customers")
    .upsert(record, { onConflict: "workspace_id,shopify_customer_id" })
    .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
    .single();

  // Recalculate retention score
  if (customer) {
    const score = calculateRetentionScore(customer);
    await admin
      .from("customers")
      .update({ retention_score: score, updated_at: new Date().toISOString() })
      .eq("id", customer.id);
  }
}

// ── Order create/update handler ──

export async function handleOrderEvent(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyOrderId = String(payload.id);
  const orderEmail = ((payload.email as string) || "").toLowerCase();
  const shopifyCustomerId = (payload.customer as { id?: number })?.id
    ? String((payload.customer as { id: number }).id)
    : null;

  // Resolve customer
  let customerId: string | null = null;

  if (shopifyCustomerId) {
    const { data } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_customer_id", shopifyCustomerId)
      .single();
    if (data) customerId = data.id;
  }

  if (!customerId && orderEmail) {
    const { data } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("email", orderEmail)
      .single();
    if (data) customerId = data.id;
  }

  // Simplify line items
  const lineItems = ((payload.line_items as Record<string, unknown>[]) || []).map((li) => ({
    title: li.title,
    quantity: li.quantity,
    price_cents: dollarsToCents(li.price as string),
    sku: li.sku || null,
  }));

  // Upsert order
  await admin.from("orders").upsert(
    {
      workspace_id: workspaceId,
      shopify_order_id: shopifyOrderId,
      customer_id: customerId,
      order_number: (payload.name as string) || String(payload.order_number) || null,
      email: orderEmail || null,
      total_cents: dollarsToCents(payload.total_price as string),
      currency: (payload.currency as string) || "USD",
      financial_status: (payload.financial_status as string) || null,
      fulfillment_status: (payload.fulfillment_status as string) || null,
      line_items: lineItems,
      created_at: (payload.created_at as string) || new Date().toISOString(),
    },
    { onConflict: "workspace_id,shopify_order_id" }
  );

  // Update customer order dates + retention score
  if (customerId) {
    const { data: firstOrder } = await admin
      .from("orders")
      .select("created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    const { data: lastOrder } = await admin
      .from("orders")
      .select("created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // Update customer stats from Shopify payload if available
    const customerPayload = payload.customer as Record<string, unknown> | undefined;
    const customerUpdate: Record<string, unknown> = {
      first_order_at: firstOrder?.created_at || null,
      last_order_at: lastOrder?.created_at || null,
      updated_at: new Date().toISOString(),
    };

    if (customerPayload) {
      customerUpdate.total_orders = (customerPayload.orders_count as number) ?? undefined;
      customerUpdate.ltv_cents = customerPayload.total_spent
        ? dollarsToCents(customerPayload.total_spent as string)
        : undefined;
    }

    // Remove undefined values
    Object.keys(customerUpdate).forEach(
      (k) => customerUpdate[k] === undefined && delete customerUpdate[k]
    );

    await admin.from("customers").update(customerUpdate).eq("id", customerId);

    // Recalculate retention score
    const { data: customer } = await admin
      .from("customers")
      .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
      .eq("id", customerId)
      .single();

    if (customer) {
      const score = calculateRetentionScore(customer);
      await admin
        .from("customers")
        .update({ retention_score: score })
        .eq("id", customer.id);
    }
  }
}
