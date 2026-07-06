// Portal subscription-detail — reads via the commerce SDK
// (@/lib/commerce/subscription.getSubscription / getSubscriptionByContractId),
// which returns one priced SubscriptionView. Money is resolved by the SDK's
// priceSubscription; this handler layers on tax, dunning, events, payment
// method, and delivery-address resolution.

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan, portalFetch } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductMap } from "@/lib/portal/helpers/transform-subscription";
import {
  getSubscription,
  getSubscriptionByContractId,
  type SubscriptionView,
} from "@/lib/commerce/subscription";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const subscriptionDetail: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const idParam = url.searchParams.get("id") || url.searchParams.get("contractId") || "";
  if (!idParam) return jsonErr({ error: "missing_contractId" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Resolve by our UUID (the portal's canonical key) OR the legacy
  // contract id. Both paths use the SDK — no direct `subscriptions`
  // reads in the portal.
  let sub: SubscriptionView | null;
  if (UUID_RE.test(idParam)) {
    try {
      sub = await getSubscription(auth.workspaceId, idParam);
    } catch {
      sub = null;
    }
  } else {
    sub = await getSubscriptionByContractId(auth.workspaceId, idParam);
  }
  if (!sub) return jsonErr({ error: "subscription_not_found" }, 404);

  // Downstream shopify_contract_id-keyed lookups (dunning, failures,
  // events).
  const contractId = sub.shopify_contract_id || idParam;

  // Tax quote. Internal subs only — Appstle subs are handled by
  // Shopify's tax pipeline. Returns null when Avalara isn't enabled
  // or the sub isn't quote-able yet (no address, no items, etc.).
  let taxQuote: { tax_cents: number; total_cents: number } | null = null;
  if (sub.is_internal && ["active", "paused"].includes(sub.status)) {
    try {
      const { ensureFreshSubscriptionTaxQuote } = await import("@/lib/avalara-subscription");
      taxQuote = await ensureFreshSubscriptionTaxQuote(auth.workspaceId, sub.id);
    } catch (err) {
      console.warn(`[portal] ensureFreshSubscriptionTaxQuote threw for ${sub.id}:`, err);
    }
  }

  // Get lock_days from portal config
  const { data: wsConfig } = await admin.from("workspaces")
    .select("portal_config")
    .eq("id", auth.workspaceId)
    .single();
  const portalConfig = (wsConfig?.portal_config as Record<string, unknown>) || {};
  const generalConfig = (portalConfig.general || {}) as Record<string, unknown>;
  const lockDays = Number(generalConfig.lock_days) || 7;

  // Lock only truly new subs that haven't been billed yet
  let isLocked = false;
  if (sub.last_payment_status !== "succeeded") {
    const created = sub.subscription_created_at
      ? new Date(sub.subscription_created_at).getTime()
      : sub.created_at ? new Date(sub.created_at).getTime() : 0;
    if (created > 0 && Date.now() - created < lockDays * 86400000) {
      isLocked = true;
    }
  }

  // Get product images for items — pass both product_ids and
  // variant_ids so the helper can resolve via either path (Appstle
  // items may not carry product_id).
  const productIds = sub.items.map((it) => it.product_id).filter((v): v is string => !!v);
  const variantIds = sub.items.map((it) => it.variant_id).filter((v) => !!v).map(String);
  const productMap = await getProductMap(
    admin,
    auth.workspaceId,
    [...new Set(productIds)],
    [...new Set(variantIds)],
  );

  // View → frontend shape (money already resolved by the SDK).
  const contract = transformSubscription(sub, productMap);

  // Dunning cycles
  const { data: dunningCycles } = await admin.from("dunning_cycles")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
    .order("cycle_number", { ascending: false });

  // Payment failures — real declines only (exclude pending/submitted attempts).
  const { data: paymentFailures } = await admin.from("payment_failures")
    .select("payment_method_last4, attempt_type, succeeded, created_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
    .eq("result", "failed")
    .order("created_at", { ascending: false })
    .limit(10);

  // Customer events timeline
  const { data: events } = await admin.from("customer_events")
    .select("event_type, summary, created_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("customer_id", customer.id)
    .or(`properties->>shopify_contract_id.eq.${contractId},event_type.ilike.subscription%`)
    .order("created_at", { ascending: false })
    .limit(15);

  // Recovery status
  const activeDunning = dunningCycles?.find(c => ["active", "skipped", "paused"].includes(c.status));
  let recoveryStatus: string | null = null;
  if (activeDunning) {
    recoveryStatus = ["active", "skipped"].includes(activeDunning.status) ? "in_recovery" : "failed";
  } else {
    const recovered = dunningCycles?.find(c => c.status === "recovered");
    if (recovered?.recovered_at) {
      const recAt = new Date(recovered.recovered_at);
      if (Date.now() - recAt.getTime() < 7 * 24 * 60 * 60 * 1000) recoveryStatus = "recovered";
    }
  }

  // Payment update URL
  const { data: ws } = await admin.from("workspaces")
    .select("shopify_myshopify_domain")
    .eq("id", auth.workspaceId)
    .single();
  const paymentUpdateUrl = ws?.shopify_myshopify_domain
    ? `https://${ws.shopify_myshopify_domain}/account`
    : null;

  // Delivery address: prefer subscription's shipping_address, fall back
  // to the last order for this sub, then customer default.
  const subAddr = sub.shipping_address;
  let orderAddr: Record<string, unknown> | null = null;
  if (!subAddr) {
    const { data: lastOrder } = await admin.from("orders")
      .select("shipping_address")
      .eq("workspace_id", auth.workspaceId)
      .eq("subscription_id", sub.id)
      .not("shipping_address", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastOrder?.shipping_address) {
      orderAddr = lastOrder.shipping_address as Record<string, unknown>;
    }
  }
  const defaultAddr = (customer as Record<string, unknown>)?.default_address as Record<string, unknown> | null;
  const addr = subAddr || orderAddr || defaultAddr;
  if (addr) {
    contract.deliveryMethod = {
      address: {
        firstName: addr.firstName || addr.first_name || "",
        lastName: addr.lastName || addr.last_name || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        city: addr.city || "",
        // Stored addresses use snake_case (province_code/country_code);
        // order + Appstle shapes use camelCase. Accept both so state
        // isn't dropped.
        province: addr.province || addr.province_code || addr.provinceCode || "",
        provinceCode: addr.provinceCode || addr.province_code || addr.province || "",
        zip: addr.zip || "",
        country: addr.country || addr.country_code || addr.countryCode || "",
      },
    };
  }

  // Applied discounts (normalized for the frontend)
  const appliedDiscounts = sub.applied_discounts.map((d) => ({
    id: d.id as string,
    code: (d.title as string) ?? (d.code as string) ?? null,
    title: (d.title as string) ?? (d.code as string) ?? null,
    type: d.type as string, // "MANUAL" or "CODE_DISCOUNT"
    value: d.value as number,
    valueType: d.valueType as string,
  }));
  // Keep backward compat: appliedDiscount = first discount
  const appliedDiscount = appliedDiscounts[0] || null;

  // Crisis status — check if this sub has an active crisis action
  let crisisBanner: { type: string; message: string; product: string } | null = null;
  {
    const { data: crisisAction } = await admin.from("crisis_customer_actions")
      .select("auto_readd, auto_resume, paused_at, removed_item_at, cancelled, crisis_events(name, affected_product_title, status)")
      .eq("subscription_id", sub.id)
      .not("cancelled", "eq", true)
      .limit(1)
      .maybeSingle();

    if (crisisAction) {
      const ce = crisisAction.crisis_events as { name?: string; affected_product_title?: string; status?: string } | null;
      const product = ce?.affected_product_title || "an item";
      const isActive = ce?.status === "active";

      if (isActive && crisisAction.paused_at && crisisAction.auto_resume) {
        crisisBanner = {
          type: "paused",
          message: `Your subscription is paused because ${product} is out of stock. It will automatically resume when it's back in stock.`,
          product,
        };
      } else if (isActive && crisisAction.removed_item_at && crisisAction.auto_readd) {
        crisisBanner = {
          type: "removed",
          message: `${product} has been removed from your subscription because it's out of stock. It will be automatically added back when it's available.`,
          product,
        };
      } else if (isActive && crisisAction.auto_readd && !crisisAction.paused_at && !crisisAction.removed_item_at) {
        crisisBanner = {
          type: "swapped",
          message: `${product} is temporarily out of stock. Your subscription has been switched to a different flavor and will automatically switch back when it's available.`,
          product,
        };
      }
    }
  }

  // Payment method. Internal subs bill via Braintree — show the default
  // card the renewal will actually charge (customer_payment_methods,
  // same resolution as internal-subscription-renewals). Appstle subs
  // read the last Shopify order's transaction.
  let paymentMethod: { brand: string | null; last4: string | null; expiry: string | null; gateway: string | null } | null = null;
  if (sub.is_internal) {
    let pm: { card_brand: string | null; last4: string | null; expiration_month: string | null; expiration_year: string | null } | null = null;
    if (sub.payment_method_id) {
      const { data } = await admin.from("customer_payment_methods")
        .select("card_brand, last4, expiration_month, expiration_year")
        .eq("workspace_id", auth.workspaceId)
        .eq("id", sub.payment_method_id)
        .eq("status", "active")
        .maybeSingle();
      pm = data;
    }
    if (!pm) {
      // Default spans the link group (one default per person) — may be
      // on a sibling.
      const { linkGroupIds } = await import("@/lib/customer-links");
      const groupIds = await linkGroupIds(admin, auth.workspaceId, sub.customer_id ?? "");
      const { data } = await admin.from("customer_payment_methods")
        .select("card_brand, last4, expiration_month, expiration_year")
        .eq("workspace_id", auth.workspaceId)
        .in("customer_id", groupIds)
        .eq("status", "active")
        .eq("is_default", true)
        .eq("provider", "braintree")
        .limit(1)
        .maybeSingle();
      pm = data;
    }
    if (pm) {
      paymentMethod = {
        brand: (pm.card_brand as string) || null,
        last4: (pm.last4 as string) || null,
        expiry: pm.expiration_month && pm.expiration_year ? `${pm.expiration_month}/${pm.expiration_year}` : null,
        gateway: "braintree",
      };
    }
  } else {
    // Find last order tied to THIS subscription, fall back to any order
    // for this customer.
    let lastOrder: { shopify_order_id: string } | null = null;
    const { data: subOrder } = await admin.from("orders")
      .select("shopify_order_id")
      .eq("workspace_id", auth.workspaceId)
      .eq("subscription_id", sub.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subOrder) {
      lastOrder = subOrder;
    } else {
      const { data: anyOrder } = await admin.from("orders")
        .select("shopify_order_id")
        .eq("workspace_id", auth.workspaceId)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lastOrder = anyOrder;
    }

    if (lastOrder?.shopify_order_id && ws?.shopify_myshopify_domain) {
      try {
        const { decrypt } = await import("@/lib/crypto");
        const { data: wsCreds } = await admin.from("workspaces")
          .select("shopify_access_token_encrypted")
          .eq("id", auth.workspaceId).single();
        if (wsCreds?.shopify_access_token_encrypted) {
          const shopToken = decrypt(wsCreds.shopify_access_token_encrypted);
          const gqlRes = await portalFetch(`https://${ws.shopify_myshopify_domain}/admin/api/2024-10/graphql.json`, {
            method: "POST",
            headers: { "X-Shopify-Access-Token": shopToken, "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `{ order(id: "gid://shopify/Order/${lastOrder.shopify_order_id}") { transactions(first: 1) { gateway paymentDetails { ... on CardPaymentDetails { company number expirationMonth expirationYear } } } } }`,
            }),
          });
          if (gqlRes.ok) {
            const gqlData = await gqlRes.json();
            const txn = gqlData.data?.order?.transactions?.[0];
            if (txn?.paymentDetails) {
              const pd = txn.paymentDetails;
              const last4 = pd.number ? pd.number.replace(/[^0-9]/g, "").slice(-4) : null;
              paymentMethod = {
                brand: pd.company || null,
                last4,
                expiry: pd.expirationMonth && pd.expirationYear ? `${pd.expirationMonth}/${pd.expirationYear}` : null,
                gateway: txn.gateway || null,
              };
            }
          }
        }
      } catch { /* non-fatal — payment method display is best-effort */ }
    }
  }

  // First-delivery mutation gate (anti-gaming): block content/schedule/
  // discount changes until the first order is delivered. Surfaced so
  // both portals can disable the options + show why. Cheap for
  // delivered subs (stored flag); a live EasyPost lookup only happens
  // for an undelivered internal sub.
  const { canMutateSubscription } = await import("@/lib/portal/mutation-guard");
  const mutationGate = await canMutateSubscription(auth.workspaceId, { id: sub.id, is_internal: sub.is_internal });

  // Recent orders widget — last 5 orders tied to THIS subscription,
  // newest first. Scoped by subscription_id so we never surface a
  // sibling sub's box. The fields returned are exactly what the
  // widget renders + what the honest-status classifier keys on
  // ([[../../app/portal/[slug]/_sections/order-status.ts]]).
  const { data: recentOrdersRaw } = await admin
    .from("orders")
    .select(
      "id, order_number, created_at, total_cents, financial_status, fulfillment_status, delivered_at, shopify_order_id, easypost_status, amplifier_tracking_number, amplifier_status",
    )
    .eq("workspace_id", auth.workspaceId)
    .eq("subscription_id", sub.id)
    .order("created_at", { ascending: false })
    .limit(5);
  const recentOrders = (recentOrdersRaw || []).map((o) => ({
    id: o.id as string,
    order_number: (o.order_number as string) || "",
    created_at: o.created_at as string,
    total_cents: Number(o.total_cents ?? 0),
    financial_status: (o.financial_status as string | null) ?? null,
    fulfillment_status: (o.fulfillment_status as string | null) ?? null,
    delivered_at: (o.delivered_at as string | null) ?? null,
    shopify_order_id: (o.shopify_order_id as string | null) ?? null,
    easypost_status: (o.easypost_status as string | null) ?? null,
    amplifier_tracking_number: (o.amplifier_tracking_number as string | null) ?? null,
    amplifier_status: (o.amplifier_status as string | null) ?? null,
  }));

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    contract: {
      ...contract,
      pricing: sub.pricing,
      appliedDiscount,
      appliedDiscounts,
      crisisBanner,
      paymentMethod,
      paymentManageUrl: "https://account.superfoodscompany.com/profile",
      tax: taxQuote
        ? {
            tax_cents: taxQuote.tax_cents,
            total_cents: taxQuote.total_cents,
            quoted_at: sub.avalara_quote_at,
          }
        : null,
      portalState: {
        bucket: sub.status === "cancelled" ? "cancelled" : sub.status === "paused" ? "paused" : "active",
        needsAttention: sub.last_payment_status === "failed",
        recoveryStatus,
        paymentUpdateUrl,
        isLocked,
        // First-delivery gate — true until the first order is delivered.
        mutationsLocked: !mutationGate.allowed,
        mutationsLockReason: mutationGate.reason || null,
        deliveryState: mutationGate.state || null,
      },
    },
    dunning_cycles: dunningCycles || [],
    payment_failures: paymentFailures || [],
    events: events || [],
    recent_orders: recentOrders,
  });
};
