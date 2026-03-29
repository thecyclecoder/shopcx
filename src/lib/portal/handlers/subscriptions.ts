// DB-first subscription list with contract shape transformation

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductImageMap } from "@/lib/portal/helpers/transform-subscription";

function isSubscriptionLocked(sub: Record<string, unknown>, lockDays: number): boolean {
  // Lock if subscription was created less than lockDays ago
  // Use our DB created_at as a reasonable proxy — it's set when we first sync/see the subscription
  const created = sub.created_at ? new Date(sub.created_at as string).getTime() : 0;
  if (!created) return false;
  return Date.now() - created < lockDays * 86400000;
}

type Bucket = "active" | "paused" | "cancelled" | "other";

function bucketStatus(status: string): Bucket {
  switch (status) {
    case "active": return "active";
    case "paused": return "paused";
    case "cancelled": return "cancelled";
    case "expired": return "cancelled";
    case "failed": return "active";
    default: return "other";
  }
}

export const subscriptions: RouteHandler = async ({ auth, route }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonOk({ ok: true, route, contracts: [], buckets: { active: [], paused: [], cancelled: [], other: [] }, summary: { total: 0 } });

  const admin = createAdminClient();

  // DB-first: get all subscriptions for this customer
  const { data: subs } = await admin.from("subscriptions")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false });

  // Also include linked account subscriptions
  let linkedSubs: typeof subs = [];
  const { data: link } = await admin.from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .single();

  if (link?.group_id) {
    const { data: linkedCustomers } = await admin.from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id)
      .neq("customer_id", customer.id);

    if (linkedCustomers?.length) {
      const linkedIds = linkedCustomers.map(c => c.customer_id);
      const { data: linked } = await admin.from("subscriptions")
        .select("*")
        .eq("workspace_id", auth.workspaceId)
        .in("customer_id", linkedIds)
        .order("created_at", { ascending: false });
      linkedSubs = linked || [];
    }
  }

  const allSubs = [...(subs || []), ...linkedSubs];

  // Get lock_days from portal config
  const { data: wsConfig } = await admin.from("workspaces")
    .select("portal_config")
    .eq("id", auth.workspaceId)
    .single();
  const portalConfig = (wsConfig?.portal_config as Record<string, unknown>) || {};
  const general = (portalConfig.general || {}) as Record<string, unknown>;
  const lockDays = Number(general.lock_days) || 7;

  // Get product images for all items across all subscriptions
  const allProductIds = new Set<string>();
  for (const sub of allSubs) {
    const items = Array.isArray(sub.items) ? sub.items : [];
    for (const item of items) {
      if (item?.product_id) allProductIds.add(item.product_id);
    }
  }
  const productImages = await getProductImageMap(admin, auth.workspaceId, Array.from(allProductIds));

  // Load dunning status for all contracts
  const contractIds = allSubs.map(s => s.shopify_contract_id).filter(Boolean);
  const dunningMap: Record<string, { status: string; recovered_at: string | null }> = {};

  if (contractIds.length) {
    const { data: cycles } = await admin.from("dunning_cycles")
      .select("shopify_contract_id, status, recovered_at")
      .eq("workspace_id", auth.workspaceId)
      .in("shopify_contract_id", contractIds)
      .order("cycle_number", { ascending: false });

    for (const c of cycles || []) {
      if (!dunningMap[c.shopify_contract_id]) {
        dunningMap[c.shopify_contract_id] = { status: c.status, recovered_at: c.recovered_at };
      }
    }
  }

  // Transform, annotate, and bucket
  const buckets: Record<Bucket, unknown[]> = { active: [], paused: [], cancelled: [], other: [] };
  let needsAttentionCount = 0;

  const contracts = allSubs.map(sub => {
    const bucket = bucketStatus(sub.status);
    const dunning = dunningMap[sub.shopify_contract_id];
    const needsAttention = sub.last_payment_status === "failed" || (dunning && ["active", "skipped"].includes(dunning.status));

    let recoveryStatus: string | null = null;
    if (dunning) {
      if (["active", "skipped"].includes(dunning.status)) recoveryStatus = "in_recovery";
      else if (["paused", "exhausted"].includes(dunning.status)) recoveryStatus = "failed";
      else if (dunning.status === "recovered" && dunning.recovered_at) {
        const recAt = new Date(dunning.recovered_at);
        if (Date.now() - recAt.getTime() < 7 * 24 * 60 * 60 * 1000) recoveryStatus = "recovered";
      }
    }

    if (needsAttention) needsAttentionCount++;

    // Transform DB shape → frontend contract shape
    const contract = transformSubscription(sub, productImages);

    const enriched = {
      ...contract,
      portalState: {
        bucket,
        needsAttention: !!needsAttention,
        attentionReason: needsAttention ? "payment_failed" : "",
        recoveryStatus,
        isLinkedAccount: linkedSubs?.some(l => l.id === sub.id) || false,
        isLocked: isSubscriptionLocked(sub, lockDays),
      },
    };

    buckets[bucket].push(enriched);
    return enriched;
  });

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    summary: {
      total: contracts.length,
      active_count: buckets.active.length,
      paused_count: buckets.paused.length,
      cancelled_count: buckets.cancelled.length,
      needs_attention_count: needsAttentionCount,
    },
    contracts,
    buckets,
  });
};
