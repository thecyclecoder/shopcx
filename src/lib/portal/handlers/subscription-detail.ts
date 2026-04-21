import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductMap } from "@/lib/portal/helpers/transform-subscription";
// decrypt removed — discounts now read from local DB, not Appstle API

export const subscriptionDetail: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const contractId = url.searchParams.get("id") || url.searchParams.get("contractId") || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // DB-first lookup
  const { data: sub } = await admin.from("subscriptions")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
    .single();

  if (!sub) return jsonErr({ error: "subscription_not_found" }, 404);

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

  // Get product images for items
  const productIds = (Array.isArray(sub.items) ? sub.items : [])
    .map((item: { product_id?: string }) => item?.product_id)
    .filter(Boolean) as string[];
  const productMap = await getProductMap(admin, auth.workspaceId, [...new Set(productIds)]);

  // Transform to frontend shape
  const contract = transformSubscription(sub, productMap);

  // Dunning cycles
  const { data: dunningCycles } = await admin.from("dunning_cycles")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
    .order("cycle_number", { ascending: false });

  // Payment failures
  const { data: paymentFailures } = await admin.from("payment_failures")
    .select("payment_method_last4, attempt_type, succeeded, created_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
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
        province: addr.province || "",
        provinceCode: addr.provinceCode || "",
        zip: addr.zip || "",
        country: addr.country || "",
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

  // Payment method — from the most recent order tied to this subscription
  let paymentMethod: { brand: string | null; last4: string | null; expiry: string | null; gateway: string | null } | null = null;
  {
    const { data: lastOrder } = await admin.from("orders")
      .select("payment_details")
      .eq("workspace_id", auth.workspaceId)
      .eq("customer_id", customer.id)
      .not("payment_details", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastOrder?.payment_details) {
      const pd = lastOrder.payment_details as { company?: string; number?: string; expirationMonth?: number; expirationYear?: number; gateway?: string };
      const last4 = pd.number ? pd.number.replace(/[^0-9]/g, "").slice(-4) : null;
      paymentMethod = {
        brand: pd.company || null,
        last4,
        expiry: pd.expirationMonth && pd.expirationYear ? `${pd.expirationMonth}/${pd.expirationYear}` : null,
        gateway: pd.gateway || null,
      };
    }
  }

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    contract: {
      ...contract,
      appliedDiscount,
      appliedDiscounts,
      crisisBanner,
      paymentMethod,
      paymentManageUrl: "https://account.superfoodscompany.com/profile",
      portalState: {
        bucket: sub.status === "cancelled" ? "cancelled" : sub.status === "paused" ? "paused" : "active",
        needsAttention: sub.last_payment_status === "failed",
        recoveryStatus,
        paymentUpdateUrl,
        isLocked,
      },
    },
    dunning_cycles: dunningCycles || [],
    payment_failures: paymentFailures || [],
    events: events || [],
  });
};
