import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductImageMap } from "@/lib/portal/helpers/transform-subscription";

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

  // Get product images for items
  const productIds = (Array.isArray(sub.items) ? sub.items : [])
    .map((item: { product_id?: string }) => item?.product_id)
    .filter(Boolean) as string[];
  const productImages = await getProductImageMap(admin, auth.workspaceId, [...new Set(productIds)]);

  // Transform to frontend shape
  const contract = transformSubscription(sub, productImages);

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

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    contract: {
      ...contract,
      portalState: {
        bucket: sub.status === "cancelled" ? "cancelled" : sub.status === "paused" ? "paused" : "active",
        needsAttention: sub.last_payment_status === "failed",
        recoveryStatus,
        paymentUpdateUrl,
      },
    },
    dunning_cycles: dunningCycles || [],
    payment_failures: paymentFailures || [],
    events: events || [],
  });
};
