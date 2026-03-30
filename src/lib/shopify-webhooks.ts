import { createHmac } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { calculateRetentionScore } from "@/lib/retention-score";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { logCustomerEvent } from "@/lib/customer-events";
import { evaluateRules } from "@/lib/rules-engine";
import { normalizeShopifyShippingAddress } from "@/lib/address-normalize";
import { inngest } from "@/lib/inngest/client";

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

// ── GraphQL enrichment ──

function mapSubscriptionStatus(
  shopifyStatus: string | null | undefined
): "active" | "paused" | "cancelled" | "never" {
  switch (shopifyStatus) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    case "CANCELLED": case "EXPIRED": case "FAILED": return "cancelled";
    default: return "never";
  }
}

interface CustomerEnrichment {
  productSubscriberStatus: string | null;
  emailMarketingState: string | null;
  smsMarketingState: string | null;
}

async function fetchCustomerEnrichment(
  shop: string,
  accessToken: string,
  shopifyCustomerId: string
): Promise<CustomerEnrichment> {
  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
  const query = `{
    customer(id: "${gid}") {
      productSubscriberStatus
      emailMarketingConsent { marketingState }
      smsMarketingConsent { marketingState }
    }
  }`;

  try {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!res.ok) return { productSubscriberStatus: null, emailMarketingState: null, smsMarketingState: null };
    const json = await res.json();
    const c = json.data?.customer;
    return {
      productSubscriberStatus: c?.productSubscriberStatus || null,
      emailMarketingState: c?.emailMarketingConsent?.marketingState || null,
      smsMarketingState: c?.smsMarketingConsent?.marketingState || null,
    };
  } catch {
    return { productSubscriberStatus: null, emailMarketingState: null, smsMarketingState: null };
  }
}

async function getShopCredentials(workspaceId: string): Promise<{ shop: string; accessToken: string } | null> {
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.shopify_access_token_encrypted || !workspace?.shopify_myshopify_domain) {
    return null;
  }

  return {
    shop: workspace.shopify_myshopify_domain,
    accessToken: decrypt(workspace.shopify_access_token_encrypted),
  };
}

// ── Dispute (chargeback) handler ──

export async function handleDisputeEvent(
  workspaceId: string,
  payload: Record<string, unknown>,
  topic: string
) {
  const admin = createAdminClient();
  const disputeId = String(payload.id);
  const isCreate = topic === "disputes/create";

  // Map Shopify dispute fields
  const disputeType = (payload.type as string) === "inquiry" ? "inquiry" : "chargeback";
  const reason = (payload.reason as string) || null;
  const status = mapDisputeStatus((payload.status as string) || "");
  const amountCents = dollarsToCents(payload.amount as string);
  const currency = (payload.currency as string) || "USD";
  const networkReasonCode = (payload.network_reason_code as string) || null;
  const evidenceDueBy = (payload.evidence_due_by as string) || null;
  const evidenceSentOn = (payload.evidence_sent_on as string) || null;
  const finalizedOn = (payload.finalized_on as string) || null;
  const shopifyOrderId = payload.order_id ? String(payload.order_id) : null;
  const initiatedAt = (payload.initiated_at as string) || new Date().toISOString();

  if (isCreate) {
    // Check idempotency — don't insert duplicates
    const { data: existing } = await admin
      .from("chargeback_events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_dispute_id", disputeId)
      .maybeSingle();

    if (existing) {
      console.log(`Duplicate disputes/create for ${disputeId}, skipping`);
      return;
    }

    const { data: inserted } = await admin
      .from("chargeback_events")
      .insert({
        workspace_id: workspaceId,
        shopify_dispute_id: disputeId,
        shopify_order_id: shopifyOrderId,
        dispute_type: disputeType,
        reason,
        network_reason_code: networkReasonCode,
        amount_cents: amountCents,
        currency,
        status,
        evidence_due_by: evidenceDueBy,
        evidence_sent_on: evidenceSentOn,
        finalized_on: finalizedOn,
        raw_payload: payload,
        initiated_at: initiatedAt,
      })
      .select("id")
      .single();

    if (inserted) {
      // Fire Inngest event for async processing
      inngest.send({
        name: "chargeback/received",
        data: { chargebackEventId: inserted.id, workspaceId },
      }).catch(() => {});
    }
  } else {
    // disputes/update — update existing row
    const { data: existing } = await admin
      .from("chargeback_events")
      .select("id, status, auto_action_taken")
      .eq("workspace_id", workspaceId)
      .eq("shopify_dispute_id", disputeId)
      .maybeSingle();

    if (!existing) {
      console.error(`disputes/update for unknown dispute ${disputeId}`);
      return;
    }

    await admin
      .from("chargeback_events")
      .update({
        status,
        evidence_sent_on: evidenceSentOn,
        finalized_on: finalizedOn,
        raw_payload: payload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    // Fire outcome events
    if (status === "won") {
      inngest.send({
        name: "chargeback/won",
        data: { chargebackEventId: existing.id, workspaceId },
      }).catch(() => {});
    } else if (status === "lost") {
      inngest.send({
        name: "chargeback/lost",
        data: { chargebackEventId: existing.id, workspaceId },
      }).catch(() => {});
    }
  }
}

function mapDisputeStatus(shopifyStatus: string): string {
  switch (shopifyStatus) {
    case "needs_response":
    case "under_review":
      return "under_review";
    case "accepted":
      return "accepted";
    case "won":
      return "won";
    case "lost":
      return "lost";
    default:
      return "under_review";
  }
}

// ── Customer update handler ──

export async function handleCustomerUpdate(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();
  const shopifyCustomerId = String(payload.id);
  const email = ((payload.email as string) || "").toLowerCase();

  // Enrich with subscription + marketing status via GraphQL
  let enrichment: CustomerEnrichment = { productSubscriberStatus: null, emailMarketingState: null, smsMarketingState: null };
  const creds = await getShopCredentials(workspaceId);
  if (creds) {
    enrichment = await fetchCustomerEnrichment(creds.shop, creds.accessToken, shopifyCustomerId);
  }

  // Build address from webhook payload
  const defaultAddr = payload.default_address as Record<string, unknown> | undefined;
  const addresses = payload.addresses as Record<string, unknown>[] | undefined;

  // Upsert customer
  const record: Record<string, unknown> = {
    workspace_id: workspaceId,
    shopify_customer_id: shopifyCustomerId,
    email: email || `no-email-${shopifyCustomerId}@unknown.com`,
    first_name: (payload.first_name as string) || null,
    last_name: (payload.last_name as string) || null,
    phone: (payload.phone as string) || null,
    total_orders: (payload.orders_count as number) ?? 0,
    ltv_cents: dollarsToCents(payload.total_spent as string),
    tags: payload.tags ? (payload.tags as string).split(", ").filter(Boolean) : [],
    locale: (payload.locale as string) || null,
    note: (payload.note as string) || null,
    shopify_state: (payload.state as string) || null,
    valid_email: (payload.verified_email as boolean) ?? true,
    shopify_created_at: (payload.created_at as string) || null,
    default_address: defaultAddr ? {
      address1: defaultAddr.address1,
      address2: defaultAddr.address2,
      city: defaultAddr.city,
      province: defaultAddr.province,
      provinceCode: defaultAddr.province_code,
      country: defaultAddr.country,
      countryCodeV2: defaultAddr.country_code,
      zip: defaultAddr.zip,
    } : null,
    addresses: addresses ? addresses.map((a) => ({
      address1: a.address1,
      address2: a.address2,
      city: a.city,
      province: a.province,
      provinceCode: a.province_code,
      country: a.country,
      countryCodeV2: a.country_code,
      zip: a.zip,
    })) : [],
    updated_at: new Date().toISOString(),
  };

  if (enrichment.productSubscriberStatus) {
    record.subscription_status = mapSubscriptionStatus(enrichment.productSubscriberStatus);
  }
  if (enrichment.emailMarketingState) {
    record.email_marketing_status = enrichment.emailMarketingState.toLowerCase();
  }
  if (enrichment.smsMarketingState) {
    record.sms_marketing_status = enrichment.smsMarketingState.toLowerCase();
  }

  // Merge logic: if an email-only customer exists (created from a ticket/inbound email),
  // absorb it into this Shopify customer instead of creating a duplicate.
  if (email) {
    const { data: emailOnly } = await admin
      .from("customers")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("email", email)
      .is("shopify_customer_id", null)
      .single();

    if (emailOnly) {
      // Check if a customer with this shopify_customer_id already exists
      const { data: existing } = await admin
        .from("customers")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_customer_id", shopifyCustomerId)
        .single();

      if (existing) {
        // Both exist — reassign tickets/orders from email-only to Shopify customer, then delete email-only
        await admin.from("tickets").update({ customer_id: existing.id }).eq("customer_id", emailOnly.id);
        await admin.from("orders").update({ customer_id: existing.id }).eq("customer_id", emailOnly.id);
        await admin.from("subscriptions").update({ customer_id: existing.id }).eq("customer_id", emailOnly.id);
        await admin.from("customers").delete().eq("id", emailOnly.id);
      } else {
        // No Shopify customer yet — just stamp the shopify_customer_id onto the email-only record
        // so the upsert below matches on the conflict key and updates it in place
        await admin.from("customers")
          .update({ shopify_customer_id: shopifyCustomerId })
          .eq("id", emailOnly.id);
      }
    }
  }

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

    // Log event
    await logCustomerEvent({
      workspaceId,
      customerId: customer.id,
      eventType: "customer.updated",
      source: "shopify",
      summary: `Customer profile updated`,
      properties: {
        subscription_status: record.subscription_status,
        email: record.email,
      },
    });

    // Evaluate rules
    await evaluateRules(workspaceId, "customer.updated", { customer });
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

  // Check if order already exists (to distinguish create vs update)
  const { data: existingOrder } = await admin
    .from("orders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_order_id", shopifyOrderId)
    .single();
  const isNewOrder = !existingOrder;

  // Upsert order
  const shippingAddr = payload.shipping_address as Record<string, unknown> | null;
  const { error: orderError } = await admin.from("orders").upsert(
    {
      workspace_id: workspaceId,
      shopify_order_id: shopifyOrderId,
      shopify_customer_id: shopifyCustomerId,
      customer_id: customerId,
      order_number: (payload.name as string) || String(payload.order_number) || null,
      email: orderEmail || null,
      total_cents: dollarsToCents(payload.total_price as string),
      currency: (payload.currency as string) || "USD",
      financial_status: (payload.financial_status as string) || null,
      fulfillment_status: (payload.fulfillment_status as string) || null,
      line_items: lineItems,
      source_name: (payload.source_name as string) || null,
      tags: (payload.tags as string) || null,
      fulfillments: ((payload.fulfillments as Record<string, unknown>[]) || []).map((f) => ({
        trackingInfo: ((f.tracking_numbers as string[]) || []).map((num, i) => ({
          number: num,
          url: (f.tracking_urls as string[])?.[i] || null,
          company: (f.tracking_company as string) || null,
        })),
        status: f.status || null,
        createdAt: f.created_at || null,
      })),
      shipping_address: shippingAddr || null,
      normalized_shipping_address: normalizeShopifyShippingAddress(shippingAddr),
      created_at: (payload.created_at as string) || new Date().toISOString(),
    },
    { onConflict: "workspace_id,shopify_order_id" }
  );

  if (orderError) {
    console.error("Order webhook upsert error:", orderError.message);
  }

  // Link subscription orders to their contract
  const sourceName = (payload.source_name as string) || "";
  if (!orderError && shopifyCustomerId && sourceName.includes("subscription")) {
    try {
      const { data: subs } = await admin
        .from("subscriptions")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_customer_id", shopifyCustomerId)
        .in("status", ["active", "paused"]);

      if (subs?.length === 1) {
        // Single active subscription — direct link
        await admin.from("orders")
          .update({ subscription_id: subs[0].id })
          .eq("workspace_id", workspaceId)
          .eq("shopify_order_id", shopifyOrderId);
      } else if (subs && subs.length > 1) {
        // Multiple subscriptions — try matching by line item SKUs
        const orderSkus = new Set(lineItems.map((li: { sku: unknown }) => String(li.sku || "")).filter(Boolean));
        if (orderSkus.size > 0) {
          const { data: subsWithItems } = await admin
            .from("subscriptions")
            .select("id, items")
            .eq("workspace_id", workspaceId)
            .eq("shopify_customer_id", shopifyCustomerId)
            .in("status", ["active", "paused"]);

          const match = subsWithItems?.find((s) => {
            const subSkus = (Array.isArray(s.items) ? s.items : [])
              .map((i: { sku?: string }) => String(i.sku || "")).filter(Boolean);
            return subSkus.some((sk) => orderSkus.has(sk));
          });
          if (match) {
            await admin.from("orders")
              .update({ subscription_id: match.id })
              .eq("workspace_id", workspaceId)
              .eq("shopify_order_id", shopifyOrderId);
          }
        }
      }
    } catch (e) {
      console.error("Subscription linkage error:", e);
    }
  }

  // Fire fraud check for new orders only (async, non-blocking)
  if (!orderError && isNewOrder) {
    // Look up the order UUID for the fraud check
    const { data: savedOrder } = await admin
      .from("orders")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_order_id", shopifyOrderId)
      .single();

    if (savedOrder) {
      inngest.send({
        name: "fraud/order.check",
        data: { orderId: savedOrder.id, customerId, workspaceId },
      }).catch(() => {}); // fire and forget
    }
  }

  // Update customer stats from DB (not payload — payload may be incomplete)
  if (customerId) {
    // Count orders and sum LTV from our DB (source of truth)
    const { count: orderCount } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId);

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

    // Sum total cents
    const { data: ltvData } = await admin
      .from("orders")
      .select("total_cents")
      .eq("customer_id", customerId);

    const totalLtv = (ltvData || []).reduce((sum, o) => sum + (o.total_cents || 0), 0);

    const customerUpdate: Record<string, unknown> = {
      total_orders: orderCount || 0,
      ltv_cents: totalLtv,
      first_order_at: firstOrder?.created_at || null,
      last_order_at: lastOrder?.created_at || null,
      updated_at: new Date().toISOString(),
    };

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

    // Log event — only log order.created for genuinely new orders
    if (isNewOrder) {
      await logCustomerEvent({
        workspaceId,
        customerId,
        eventType: "order.created",
        source: "shopify",
        summary: `Order ${(payload.name as string) || shopifyOrderId} — $${((payload.total_price as string) || "0")}`,
        properties: {
          shopify_order_id: shopifyOrderId,
          order_number: payload.name,
          total_price: payload.total_price,
          financial_status: payload.financial_status,
          source_name: payload.source_name,
        },
      });
    }

    // Evaluate rules — only on new orders
    if (isNewOrder) {
      const orderCtx = {
        shopify_order_id: shopifyOrderId,
        order_number: payload.name,
        total_cents: Math.round(parseFloat((payload.total_price as string) || "0") * 100),
        financial_status: payload.financial_status,
        fulfillment_status: payload.fulfillment_status,
        source_name: payload.source_name,
        order_type: null as string | null,
      };
      const { data: custCtx } = customerId
        ? await admin.from("customers").select("*").eq("id", customerId).single()
        : { data: null };
      await evaluateRules(workspaceId, "order.created", {
        order: orderCtx,
        customer: custCtx || undefined,
      });
    }
  }
}
