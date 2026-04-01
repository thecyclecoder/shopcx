import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductMap } from "@/lib/portal/helpers/transform-subscription";
import { decrypt } from "@/lib/crypto";

export const subscriptionDetail: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

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

  // Fetch applied discount from Appstle raw contract response
  let appliedDiscount: { code?: string; title?: string; value?: number; valueType?: string } | null = null;
  try {
    const { data: wsKeys } = await admin.from("workspaces")
      .select("appstle_api_key_encrypted")
      .eq("id", auth.workspaceId)
      .single();
    if (wsKeys?.appstle_api_key_encrypted) {
      const apiKey = decrypt(wsKeys.appstle_api_key_encrypted);
      const rawRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/contract-raw-response?contractId=${contractId}&api_key=${apiKey}`,
        { headers: { "X-API-Key": apiKey } },
      );
      if (rawRes.ok) {
        const rawText = await rawRes.text();
        const nodesMatch = rawText.match(/"discounts"[\s\S]*?"nodes"\s*:\s*\[([\s\S]*?)\]/);
        if (nodesMatch && nodesMatch[1].trim()) {
          try {
            const nodes = JSON.parse(`[${nodesMatch[1]}]`);
            const firstDiscount = nodes[0];
            if (firstDiscount) {
              // Extract discount title/code and value
              const title = firstDiscount.title || "";
              const valueNode = firstDiscount.value;
              if (valueNode?.percentage) {
                appliedDiscount = { code: title, title, value: valueNode.percentage, valueType: "PERCENTAGE" };
              } else if (valueNode?.fixedAmount?.amount) {
                appliedDiscount = { code: title, title, value: Number(valueNode.fixedAmount.amount), valueType: "FIXED_AMOUNT" };
              } else {
                appliedDiscount = { code: title, title };
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    contract: {
      ...contract,
      appliedDiscount,
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
