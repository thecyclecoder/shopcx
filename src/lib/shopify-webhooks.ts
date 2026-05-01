import { createHmac } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { calculateRetentionScore } from "@/lib/retention-score";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { logCustomerEvent } from "@/lib/customer-events";
import { evaluateRules } from "@/lib/rules-engine";
import { normalizeShopifyShippingAddress, resolveOrderAddresses } from "@/lib/address-normalize";
import { inngest } from "@/lib/inngest/client";
import { getMemberByCustomerId, deductPoints } from "@/lib/loyalty";

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
  // NOTE: total_orders / ltv_cents are NOT trusted from this webhook payload.
  // They're computed live from the orders table by getCustomerStats() at read time
  // (see src/lib/customer-stats.ts). The columns below remain for backward compat
  // with code paths that haven't been migrated, but should not be relied on.
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
  // Marketing consent: use most permissive state (don't overwrite our "subscribed" with Shopify's null)
  // Check if we already have consent in our DB before overwriting
  if (email) {
    const { data: existingCust } = await admin.from("customers")
      .select("email_marketing_status, sms_marketing_status")
      .eq("workspace_id", workspaceId).eq("email", email).maybeSingle();

    const ourEmail = existingCust?.email_marketing_status;
    const ourSms = existingCust?.sms_marketing_status;
    const shopifyEmail = enrichment.emailMarketingState?.toLowerCase();
    const shopifySms = enrichment.smsMarketingState?.toLowerCase();

    // Take the most permissive: if either side says "subscribed", keep "subscribed"
    record.email_marketing_status = (ourEmail === "subscribed" || shopifyEmail === "subscribed") ? "subscribed" : (shopifyEmail || ourEmail || null);
    record.sms_marketing_status = (ourSms === "subscribed" || shopifySms === "subscribed") ? "subscribed" : (shopifySms || ourSms || null);

    // If we had consent that Shopify doesn't, push it to Shopify
    if (ourEmail === "subscribed" && shopifyEmail !== "subscribed") {
      try {
        const { subscribeToEmailMarketing } = await import("@/lib/shopify-marketing");
        await subscribeToEmailMarketing(workspaceId, shopifyCustomerId);
      } catch { /* non-fatal */ }
    }
    if (ourSms === "subscribed" && shopifySms !== "subscribed") {
      const phone = (payload.phone as string) || existingCust?.sms_marketing_status;
      if (phone) {
        try {
          const { subscribeToSmsMarketing } = await import("@/lib/shopify-marketing");
          await subscribeToSmsMarketing(workspaceId, shopifyCustomerId, phone as string);
        } catch { /* non-fatal */ }
      }
    }
  } else {
    if (enrichment.emailMarketingState) record.email_marketing_status = enrichment.emailMarketingState.toLowerCase();
    if (enrichment.smsMarketingState) record.sms_marketing_status = enrichment.smsMarketingState.toLowerCase();
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
    variant_id: li.variant_id ? String(li.variant_id) : null,
  }));

  // Check if order already exists (to distinguish create vs update)
  const { data: existingOrder } = await admin
    .from("orders")
    .select("id, financial_status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_order_id", shopifyOrderId)
    .single();
  const isNewOrder = !existingOrder;
  const previousFinancialStatus = existingOrder?.financial_status || null;

  // Extract delivery status from fulfillments
  // shipment_status values: confirmed, in_transit, out_for_delivery, delivered, failure
  const deliveryRank: Record<string, number> = { confirmed: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 };
  const rawFulfillments = (payload.fulfillments as Record<string, unknown>[]) || [];
  let deliveryStatus: string | null = null;
  let deliveredAt: string | null = null;

  for (const f of rawFulfillments) {
    const ss = (f.shipment_status as string || "").toLowerCase();
    if (ss && (deliveryRank[ss] || 0) > (deliveryRank[deliveryStatus || ""] || 0)) {
      deliveryStatus = ss;
    }
    if (ss === "delivered" && f.updated_at && !deliveredAt) {
      deliveredAt = f.updated_at as string;
    }
  }

  // Address fallback chain (see feedback_address_mirror_rule):
  //   1. shipping_address as-is if present, billing_address as-is if present
  //   2. if only one is populated, mirror it into both
  //   3. if both null, leave null here — a follow-up Inngest job (fired
  //      below) will fetch customer.defaultAddress and backfill async,
  //      keeping the webhook response fast.
  const rawShipping = (payload.shipping_address as Record<string, unknown> | null) || null;
  const rawBilling = (payload.billing_address as Record<string, unknown> | null) || null;
  const { shipping_address: shippingAddr, billing_address: billingAddr } = resolveOrderAddresses(rawShipping, rawBilling);
  const needsCustomerDefaultFallback = !rawShipping && !rawBilling;

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
      fulfillments: rawFulfillments.map((f) => ({
        trackingInfo: ((f.tracking_numbers as string[]) || []).map((num, i) => ({
          number: num,
          url: (f.tracking_urls as string[])?.[i] || null,
          company: (f.tracking_company as string) || null,
        })),
        status: f.status || null,
        shipmentStatus: f.shipment_status || null,
        createdAt: f.created_at || null,
      })),
      shipping_address: shippingAddr,
      billing_address: billingAddr,
      normalized_shipping_address: normalizeShopifyShippingAddress(shippingAddr),
      discount_codes: ((payload.discount_codes as { code: string; amount: string; type: string }[]) || []).map((dc) => dc.code),
      created_at: (payload.created_at as string) || new Date().toISOString(),
      delivery_status: deliveryStatus,
      ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
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
      let matched = false;

      // PRIMARY: Get contract ID from Shopify order metafield (Appstle stores it there)
      try {
        const { getShopifyCredentials } = await import("@/lib/shopify-sync");
        const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
        const { shop: shopDomain, accessToken } = await getShopifyCredentials(workspaceId);
        const gqlRes = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `{ order(id: "gid://shopify/Order/${shopifyOrderId}") { metafields(first: 5, keys: ["appstle_subscription.details"]) { nodes { value } } } }`,
          }),
        });
        const gqlData = await gqlRes.json();
        const metaValue = gqlData?.data?.order?.metafields?.nodes?.[0]?.value;
        if (metaValue) {
          const parsed = JSON.parse(metaValue);
          const contractId = String(parsed?.subscriptionContract?.id || "");
          if (contractId) {
            const { data: sub } = await admin.from("subscriptions")
              .select("id").eq("shopify_contract_id", contractId).eq("workspace_id", workspaceId).maybeSingle();
            if (sub) {
              await admin.from("orders")
                .update({ subscription_id: sub.id })
                .eq("workspace_id", workspaceId)
                .eq("shopify_order_id", shopifyOrderId);
              matched = true;
            }
          }
        }
      } catch { /* metafield lookup failed — fall through to SKU matching */ }

      // FALLBACK: SKU matching
      if (!matched) {
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
            matched = true;
          }
        }

        // Last resort: single sub assignment
        if (!matched) {
          const { data: subs } = await admin.from("subscriptions").select("id")
            .eq("workspace_id", workspaceId).eq("shopify_customer_id", shopifyCustomerId).in("status", ["active", "paused"]);
          if (subs?.length === 1) {
            await admin.from("orders")
              .update({ subscription_id: subs[0].id })
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

      // Address fallback step 3: if the webhook payload had neither
      // shipping nor billing (subscription renewal where Shopify only
      // stores them on the contract / customer), schedule a follow-up
      // job to pull customer.defaultAddress and backfill the order.
      if (needsCustomerDefaultFallback) {
        inngest.send({
          name: "orders/address-fallback",
          data: { orderId: savedOrder.id, workspaceId },
        }).catch(() => {});
      }
    }

    // Kick off demographic enrichment for this customer. The handler
    // sleeps ~1h before reading data so we pick up the order + any
    // related subscription once everything has settled.
    if (customerId) {
      inngest.send({
        name: "demographics/enrich-single",
        data: { workspace_id: workspaceId, customer_id: customerId },
      }).catch(() => {});
    }
  }

  // Duplicate order detection: check for multiple paid orders on the same subscription within 7 days
  if (!orderError && isNewOrder && sourceName.includes("subscription")) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const orderName = (payload.name as string) || shopifyOrderId;

      // Find which subscription this order belongs to
      const { data: thisOrder } = await admin
        .from("orders")
        .select("subscription_id")
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", shopifyOrderId)
        .single();

      if (thisOrder?.subscription_id) {
        const { data: recentOrders } = await admin
          .from("orders")
          .select("id, order_number, total_cents, created_at")
          .eq("workspace_id", workspaceId)
          .eq("subscription_id", thisOrder.subscription_id)
          .eq("financial_status", "paid")
          .gte("created_at", sevenDaysAgo)
          .neq("shopify_order_id", shopifyOrderId)
          .order("created_at", { ascending: false })
          .limit(1);

        const newTotalCents = Math.round(parseFloat((payload.total_price as string) || "0") * 100);
        if (recentOrders && recentOrders.length > 0 && recentOrders[0].total_cents === newTotalCents) {
          const prior = recentOrders[0];
          // Same subscription, same amount, within 7 days — likely a double charge
          const { data: existingNotifs } = await admin
            .from("dashboard_notifications")
            .select("id, metadata")
            .eq("workspace_id", workspaceId)
            .eq("type", "duplicate_order_alert")
            .eq("dismissed", false);

          const alreadyNotified = existingNotifs?.some(
            (n) => (n.metadata as { shopify_order_id?: string })?.shopify_order_id === shopifyOrderId
          );

          if (!alreadyNotified) {
            await admin.from("dashboard_notifications").insert({
              workspace_id: workspaceId,
              type: "duplicate_order_alert",
              title: `Duplicate order detected: ${orderName}`,
              body: `${orderName} ($${((payload.total_price as string) || "0")}) was created on the same subscription as ${prior.order_number} ($${(prior.total_cents / 100).toFixed(2)}) from ${new Date(prior.created_at).toLocaleDateString()}. This may be a double charge.`,
              metadata: {
                shopify_order_id: shopifyOrderId,
                order_number: orderName,
                prior_order_number: prior.order_number,
                total_price: payload.total_price,
                customer_id: customerId,
              },
            });
          }
        }
      }
    } catch (e) {
      console.error("Duplicate order detection error:", e);
    }
  }

  // Update customer stats from DB (not payload — payload may be incomplete)
  // Also update ALL linked profiles so total_orders/ltv stay accurate across linked accounts
  if (customerId) {
    // Find all linked customer IDs (including self)
    const allCustIds = [customerId];
    const { data: link } = await admin.from("customer_links")
      .select("group_id").eq("customer_id", customerId).maybeSingle();
    if (link?.group_id) {
      const { data: linked } = await admin.from("customer_links")
        .select("customer_id").eq("group_id", link.group_id);
      for (const l of linked || []) {
        if (!allCustIds.includes(l.customer_id)) allCustIds.push(l.customer_id);
      }
    }

    // Aggregate orders + LTV across ALL linked profiles
    let totalOrders = 0;
    let totalLtv = 0;
    let earliestOrder: string | null = null;
    let latestOrder: string | null = null;

    for (const cid of allCustIds) {
      const { count } = await admin.from("orders")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", cid);
      totalOrders += count || 0;

      const { data: ltvData } = await admin.from("orders")
        .select("total_cents").eq("customer_id", cid);
      totalLtv += (ltvData || []).reduce((sum, o) => sum + (o.total_cents || 0), 0);

      const { data: first } = await admin.from("orders")
        .select("created_at").eq("customer_id", cid)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      if (first?.created_at && (!earliestOrder || first.created_at < earliestOrder)) {
        earliestOrder = first.created_at;
      }

      const { data: last } = await admin.from("orders")
        .select("created_at").eq("customer_id", cid)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (last?.created_at && (!latestOrder || last.created_at > latestOrder)) {
        latestOrder = last.created_at;
      }
    }

    const customerUpdate: Record<string, unknown> = {
      total_orders: totalOrders,
      ltv_cents: totalLtv,
      first_order_at: earliestOrder,
      last_order_at: latestOrder,
      updated_at: new Date().toISOString(),
    };

    // Update ALL linked profiles with the same aggregate stats
    await admin.from("customers").update(customerUpdate).in("id", allCustIds);

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

    // Detect refund: financial_status changed to refunded or partially_refunded
    const newFinancialStatus = (payload.financial_status as string) || null;
    const isRefund = !isNewOrder
      && (newFinancialStatus === "refunded" || newFinancialStatus === "partially_refunded")
      && previousFinancialStatus !== newFinancialStatus;

    if (isRefund) {
      const orderName = (payload.name as string) || shopifyOrderId;
      const totalPrice = (payload.total_price as string) || "0";

      // Log customer event
      await logCustomerEvent({
        workspaceId,
        customerId,
        eventType: "order.refunded",
        source: "shopify",
        summary: `Order ${orderName} ${newFinancialStatus === "partially_refunded" ? "partially " : ""}refunded — $${totalPrice}`,
        properties: {
          shopify_order_id: shopifyOrderId,
          order_number: payload.name,
          total_price: totalPrice,
          financial_status: newFinancialStatus,
        },
      });

      // Deduct loyalty points earned from this order
      try {
        const member = await getMemberByCustomerId(workspaceId, customerId);
        if (member) {
          // Points earned = 1 point per dollar spent (matching earn rate)
          const pointsToDeduct = Math.floor(parseFloat(totalPrice));
          if (pointsToDeduct > 0) {
            await deductPoints(
              member,
              pointsToDeduct,
              existingOrder?.id || null,
              "refund",
              `Refund on order ${orderName}`,
            );
          }
        }
      } catch (e) {
        console.error("Loyalty deduction on refund error:", e);
      }
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

// ── Fulfillments/update handler ──

export async function handleFulfillmentUpdate(workspaceId: string, payload: Record<string, unknown>) {
  const admin = createAdminClient();

  // The fulfillment webhook payload has order_id and shipment_status
  const shopifyOrderId = payload.order_id ? String(payload.order_id) : null;
  const shipmentStatus = ((payload.shipment_status as string) || "").toLowerCase();
  const trackingNumber = (payload.tracking_number as string) || (payload.tracking_numbers as string[])?.[0] || null;
  const trackingCompany = (payload.tracking_company as string) || null;
  const updatedAt = (payload.updated_at as string) || new Date().toISOString();

  if (!shopifyOrderId) return;

  // Map shipment_status to our delivery_status
  const statusMap: Record<string, string> = {
    confirmed: "not_delivered",
    label_printed: "not_delivered",
    label_purchased: "not_delivered",
    in_transit: "not_delivered",
    out_for_delivery: "not_delivered",
    delivered: "delivered",
    attempted_delivery: "not_delivered",
    ready_for_pickup: "not_delivered",
    failure: "not_delivered",
  };

  const deliveryStatus = statusMap[shipmentStatus] || null;
  if (!deliveryStatus) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};

  if (deliveryStatus === "delivered") {
    updates.delivery_status = "delivered";
    updates.delivered_at = updatedAt;
  } else {
    // Only update if current status is less advanced
    const { data: order } = await admin.from("orders")
      .select("delivery_status")
      .eq("workspace_id", workspaceId)
      .eq("shopify_order_id", shopifyOrderId)
      .single();

    // Don't overwrite delivered/returned with a lesser status
    if (order?.delivery_status === "delivered" || order?.delivery_status === "returned") return;
  }

  if (Object.keys(updates).length > 0) {
    await admin.from("orders")
      .update(updates)
      .eq("workspace_id", workspaceId)
      .eq("shopify_order_id", shopifyOrderId);
  }
}
