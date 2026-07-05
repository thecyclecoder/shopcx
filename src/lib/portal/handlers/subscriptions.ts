// Portal subscriptions list — reads via the commerce SDK
// (@/lib/commerce/subscription.listSubscriptionsByCustomer), which
// produces one priced SubscriptionView per row (money resolved by the
// SDK's priceSubscription — no direct `subscriptions` reads here).

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { transformSubscription, getProductMap } from "@/lib/portal/helpers/transform-subscription";
import { listSubscriptionsByCustomer, type SubscriptionView } from "@/lib/commerce/subscription";

function isSubscriptionLocked(sub: SubscriptionView, lockDays: number): boolean {
  // Lock only truly new subscriptions that haven't been billed yet.
  // If they've had a successful payment, they're not new.
  if (sub.last_payment_status === "succeeded") return false;

  // For subs that haven't billed yet, check if they're younger than
  // lockDays. Use next_billing_date as a proxy: if the first billing
  // hasn't happened yet and the sub was created recently, lock it.
  const nextBilling = sub.next_billing_date ? new Date(sub.next_billing_date).getTime() : 0;
  const created = sub.created_at ? new Date(sub.created_at).getTime() : 0;
  if (!created) return false;

  // If next billing is in the future and sub is younger than lockDays, lock it
  if (nextBilling > Date.now() && Date.now() - created < lockDays * 86400000) return true;

  return false;
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

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonOk({ ok: true, route, contracts: [], buckets: { active: [], paused: [], cancelled: [], other: [] }, summary: { total: 0 } });

  const admin = createAdminClient();

  // Primary customer's subs via the commerce SDK — the returned view
  // carries `pricing` resolved by the money invariant, and the two
  // legacy portal fields (pause_resume_at, subscription_created_at).
  const primaryViews = await listSubscriptionsByCustomer(auth.workspaceId, customer.id);

  // Linked-account subs (same person, sibling profiles) — one SDK call
  // per sibling. Keep the id set so we can annotate `isLinkedAccount`
  // on each contract.
  const linkedSubIds = new Set<string>();
  const linkedViews: SubscriptionView[] = [];
  const { data: link } = await admin.from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .single();

  if (link?.group_id) {
    const { data: linkedCustomers } = await admin.from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id)
      .neq("customer_id", customer.id);

    for (const lc of linkedCustomers || []) {
      const cid = lc.customer_id as string;
      const siblings = await listSubscriptionsByCustomer(auth.workspaceId, cid);
      for (const s of siblings) {
        linkedSubIds.add(s.id);
        linkedViews.push(s);
      }
    }
  }

  const allSubs: SubscriptionView[] = [...primaryViews, ...linkedViews];

  // Get lock_days from portal config
  const { data: wsConfig } = await admin.from("workspaces")
    .select("portal_config")
    .eq("id", auth.workspaceId)
    .single();
  const portalConfig = (wsConfig?.portal_config as Record<string, unknown>) || {};
  const general = (portalConfig.general || {}) as Record<string, unknown>;
  const lockDays = Number(general.lock_days) || 7;

  // Get product images for all items across all subscriptions. Collect
  // both product_ids and variant_ids — Appstle webhook items may carry
  // either or both, and getProductMap resolves through both.
  const allProductIds = new Set<string>();
  const allVariantIds = new Set<string>();
  for (const sub of allSubs) {
    for (const item of sub.items) {
      if (item.product_id) allProductIds.add(item.product_id);
      if (item.variant_id) allVariantIds.add(String(item.variant_id));
    }
  }
  const productMap = await getProductMap(
    admin,
    auth.workspaceId,
    Array.from(allProductIds),
    Array.from(allVariantIds),
  );

  // Load dunning status for all contracts (keyed on shopify_contract_id).
  const contractIds = allSubs.map(s => s.shopify_contract_id).filter((v): v is string => !!v);
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

  // Crisis banners — check for active crisis actions on each sub
  const subDbIds = allSubs.map(s => s.id).filter(Boolean);
  const crisisMap: Record<string, { type: string; message: string; product: string }> = {};
  if (subDbIds.length) {
    const { data: crisisActions } = await admin.from("crisis_customer_actions")
      .select("subscription_id, auto_readd, auto_resume, paused_at, removed_item_at, cancelled, crisis_events(affected_product_title, status)")
      .in("subscription_id", subDbIds)
      .not("cancelled", "eq", true);

    for (const ca of crisisActions || []) {
      const ce = ca.crisis_events as { affected_product_title?: string; status?: string } | null;
      if (ce?.status !== "active") continue;
      const product = ce.affected_product_title || "an item";

      if (ca.paused_at && ca.auto_resume) {
        crisisMap[ca.subscription_id] = { type: "paused", message: `Your subscription is paused because ${product} is out of stock. It will automatically resume when it's back in stock.`, product };
      } else if (ca.removed_item_at && ca.auto_readd) {
        crisisMap[ca.subscription_id] = { type: "removed", message: `${product} has been removed because it's out of stock. It will be added back when it's available.`, product };
      } else if (ca.auto_readd && !ca.paused_at && !ca.removed_item_at) {
        crisisMap[ca.subscription_id] = { type: "swapped", message: `${product} is temporarily out of stock. Your flavor will switch back when it's available.`, product };
      }
    }
  }

  // Transform, annotate, and bucket
  const buckets: Record<Bucket, unknown[]> = { active: [], paused: [], cancelled: [], other: [] };
  let needsAttentionCount = 0;

  const contracts = allSubs.map((sub) => {
    const bucket = bucketStatus(sub.status);
    const dunning = sub.shopify_contract_id ? dunningMap[sub.shopify_contract_id] : undefined;
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

    // View → frontend contract shape. Money is already resolved by the
    // SDK; the transformer only reshapes + attaches images.
    const contract = transformSubscription(sub, productMap);

    // Surface the live coupon(s) so the detail screen's Coupon card can
    // show them + a Remove button. Normalize both shapes — internal
    // {code,type,value} and Appstle {id,title,valueType,value}.
    const appliedDiscounts = (sub.applied_discounts || []).map((d) => ({
      id: (d.id as string) ?? null,
      code: (d.code as string) ?? (d.title as string) ?? null,
      title: (d.code as string) ?? (d.title as string) ?? null,
      type: (d.type as string) ?? null,
      value: d.value ?? null,
      valueType: (d.valueType as string) ?? null,
    }));

    return {
      ...contract,
      pricing: sub.pricing,
      appliedDiscounts,
      appliedDiscount: appliedDiscounts[0] || null,
      crisisBanner: crisisMap[sub.id] || null,
      portalState: {
        bucket,
        needsAttention: !!needsAttention,
        attentionReason: needsAttention ? "payment_failed" : "",
        recoveryStatus,
        isLinkedAccount: linkedSubIds.has(sub.id),
        isLocked: isSubscriptionLocked(sub, lockDays),
      },
    };
  });

  for (const enriched of contracts) {
    buckets[enriched.portalState.bucket].push(enriched);
  }

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
