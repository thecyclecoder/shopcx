import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductMap } from "@/lib/portal/helpers/transform-subscription";
// decrypt removed — discounts now read from local DB, not Appstle API

export const subscriptionDetail: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const idParam = url.searchParams.get("id") || url.searchParams.get("contractId") || "";
  if (!idParam) return jsonErr({ error: "missing_contractId" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Resolve by our UUID (the portal's canonical key) OR the legacy contract id.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let subQuery = admin.from("subscriptions").select("*").eq("workspace_id", auth.workspaceId);
  subQuery = UUID_RE.test(idParam) ? subQuery.eq("id", idParam) : subQuery.eq("shopify_contract_id", idParam);
  const { data: sub } = await subQuery.maybeSingle();

  if (!sub) return jsonErr({ error: "subscription_not_found" }, 404);
  // Downstream shopify_contract_id-keyed lookups (dunning, failures, events).
  const contractId = (sub.shopify_contract_id as string) || idParam;

  // Tax quote. Internal subs only — Appstle subs are handled by
  // Shopify's tax pipeline. Returns null when Avalara isn't enabled
  // or the sub isn't quote-able yet (no address, no items, etc.).
  let taxQuote: { tax_cents: number; total_cents: number } | null = null;
  if (sub.is_internal && ["active", "paused"].includes(sub.status as string)) {
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
  const itemsArr = (Array.isArray(sub.items) ? sub.items : []) as Array<{ product_id?: string; variant_id?: string | number }>;
  const productIds = itemsArr.map((it) => it.product_id).filter(Boolean) as string[];
  const variantIds = itemsArr.map((it) => (it.variant_id != null ? String(it.variant_id) : "")).filter(Boolean);
  const productMap = await getProductMap(
    admin,
    auth.workspaceId,
    [...new Set(productIds)],
    [...new Set(variantIds)],
  );

  // Transform to frontend shape
  const contract = transformSubscription(sub, productMap);

  // Layer live pricing onto the contract — lines get a strikethrough base +
  // charged price, plus the per-delivery total + qualified-discount pills.
  // Internal subs price via the engine; Appstle subs keep baked prices and just
  // get the coupon reflected.
  let pricing: Awaited<ReturnType<typeof import("@/lib/portal/helpers/enrich-pricing").enrichContractPricing>> | null = null;
  try {
    const { enrichContractPricing } = await import("@/lib/portal/helpers/enrich-pricing");
    pricing = await enrichContractPricing(auth.workspaceId, sub, contract as unknown as Record<string, unknown> & { lines?: unknown });
  } catch (err) {
    console.warn(`[portal] enrichContractPricing failed for ${sub.id}:`, err);
  }

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

  // Add delivery address: prefer subscription's shipping_address, fall back to last order, then customer default
  const subAddr = sub.shipping_address as Record<string, unknown> | null;
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
  const dm = contract.deliveryMethod as { address?: { address1?: string } } | null;
  const hasDeliveryAddress = dm?.address?.address1;
  if (addr && !hasDeliveryAddress) {
    contract.deliveryMethod = {
      address: {
        firstName: addr.firstName || addr.first_name || "",
        lastName: addr.lastName || addr.last_name || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        city: addr.city || "",
        // Stored addresses use snake_case (province_code/country_code); order +
        // Appstle shapes use camelCase. Accept both so the state isn't dropped.
        province: addr.province || addr.province_code || addr.provinceCode || "",
        provinceCode: addr.provinceCode || addr.province_code || addr.province || "",
        zip: addr.zip || "",
        country: addr.country || addr.country_code || addr.countryCode || "",
      },
    };
  }

  // Read applied discounts from local DB (synced via Appstle webhook)
  const discounts = (sub.applied_discounts as { id: string; title: string; type: string; value: number; valueType: string }[]) || [];
  const appliedDiscounts = discounts.map(d => ({
    id: d.id,
    code: d.title,
    title: d.title,
    type: d.type, // "MANUAL" or "CODE_DISCOUNT"
    value: d.value,
    valueType: d.valueType,
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

  // Payment method. Internal subs bill via Braintree — show the default card the
  // renewal will actually charge (customer_payment_methods, same resolution as
  // internal-subscription-renewals). Appstle subs read the last Shopify order's
  // transaction.
  let paymentMethod: { brand: string | null; last4: string | null; expiry: string | null; gateway: string | null } | null = null;
  if (sub.is_internal) {
    // Show the sub's PINNED card if set + still valid, else the customer default —
    // mirrors the renewal's resolution so the displayed card is what gets charged.
    let pm: { card_brand: string | null; last4: string | null; expiration_month: string | null; expiration_year: string | null } | null = null;
    if (sub.payment_method_id) {
      const { data } = await admin.from("customer_payment_methods")
        .select("card_brand, last4, expiration_month, expiration_year")
        .eq("workspace_id", auth.workspaceId)
        .eq("id", sub.payment_method_id as string)
        .eq("status", "active")
        .maybeSingle();
      pm = data;
    }
    if (!pm) {
      // Default spans the link group (one default per person) — may be on a sibling.
      const { linkGroupIds } = await import("@/lib/customer-links");
      const groupIds = await linkGroupIds(admin, auth.workspaceId, sub.customer_id as string);
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
    // Find last order tied to THIS subscription, fall back to any order for this customer
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
          const gqlRes = await fetch(`https://${ws.shopify_myshopify_domain}/admin/api/2024-10/graphql.json`, {
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

  // First-delivery mutation gate (anti-gaming): block content/schedule/discount
  // changes until the first order is delivered. Surfaced so both portals can
  // disable the options + show why. Cheap for delivered subs (stored flag);
  // a live EasyPost lookup only happens for an undelivered internal sub.
  const { canMutateSubscription } = await import("@/lib/portal/mutation-guard");
  const mutationGate = await canMutateSubscription(auth.workspaceId, sub as { id: string; is_internal?: boolean | null });

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    contract: {
      ...contract,
      pricing,
      appliedDiscount,
      appliedDiscounts,
      crisisBanner,
      paymentMethod,
      paymentManageUrl: "https://account.superfoodscompany.com/profile",
      tax: taxQuote
        ? {
            tax_cents: taxQuote.tax_cents,
            total_cents: taxQuote.total_cents,
            quoted_at: sub.avalara_quote_at as string | null,
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
  });
};
