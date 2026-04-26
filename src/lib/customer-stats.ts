/**
 * Customer stats (LTV, total_orders, first/last order dates) computed live from
 * the orders table. We previously stored these as denormalized columns on the
 * customers row, but they kept drifting (Shopify webhooks with missing/zero
 * order_count would zero them out). Always read via this helper.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface CustomerStats {
  ltv_cents: number;
  total_orders: number;
  first_order_at: string | null;
  last_order_at: string | null;
}

/**
 * Compute LTV + order count from the orders table. Includes linked-account
 * customers (same group_id in customer_links) so multi-profile customers see
 * their full history.
 *
 * Excludes orders with financial_status = "refunded" (full refunds) from LTV.
 * Partial refunds still count at full amount — we don't currently store the
 * net-of-refund amount on the order row.
 */
export async function getCustomerStats(customerId: string): Promise<CustomerStats> {
  const admin = createAdminClient();

  // Find linked customer group (if any)
  const ids = [customerId];
  const { data: link } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", customerId).maybeSingle();
  if (link?.group_id) {
    const { data: members } = await admin.from("customer_links")
      .select("customer_id").eq("group_id", link.group_id);
    for (const m of members || []) {
      if (!ids.includes(m.customer_id)) ids.push(m.customer_id);
    }
  }

  const { data: orders } = await admin.from("orders")
    .select("total_cents, financial_status, created_at")
    .in("customer_id", ids);

  let ltv = 0;
  let count = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const o of orders || []) {
    count++;
    if (o.financial_status !== "refunded") ltv += o.total_cents || 0;
    if (!earliest || o.created_at < earliest) earliest = o.created_at;
    if (!latest || o.created_at > latest) latest = o.created_at;
  }

  return { ltv_cents: ltv, total_orders: count, first_order_at: earliest, last_order_at: latest };
}

/**
 * Batch version — fetches stats for many customers at once and rolls up
 * linked-account totals (so a profile in a 3-account group sees combined
 * orders/LTV across all 3, matching getCustomerStats behavior).
 *
 * Three queries regardless of page size:
 *   1. customer_links for the input ids → discover groups
 *   2. customer_links for each discovered group_id → all member ids
 *   3. orders for the union of (input ids ∪ all member ids)
 */
export async function getCustomerStatsBatch(customerIds: string[]): Promise<Map<string, CustomerStats>> {
  const out = new Map<string, CustomerStats>();
  if (customerIds.length === 0) return out;
  const admin = createAdminClient();

  // 1) Find which input ids belong to a link group
  const { data: ownLinks } = await admin.from("customer_links")
    .select("customer_id, group_id").in("customer_id", customerIds);

  // 2) Expand each group to all its members
  const groupIds = [...new Set((ownLinks || []).map(l => l.group_id))];
  const groupMembers = new Map<string, string[]>(); // group_id → all member customer_ids
  if (groupIds.length) {
    const { data: allMembers } = await admin.from("customer_links")
      .select("group_id, customer_id").in("group_id", groupIds);
    for (const m of allMembers || []) {
      const arr = groupMembers.get(m.group_id) || [];
      arr.push(m.customer_id);
      groupMembers.set(m.group_id, arr);
    }
  }

  // Build per-input expansion: input_id → list of customer_ids whose orders count toward it
  const expand = new Map<string, string[]>();
  const ownGroup = new Map<string, string>(); // input_id → group_id (if any)
  for (const l of ownLinks || []) ownGroup.set(l.customer_id, l.group_id);
  const allOrderCustomerIds = new Set<string>();
  for (const cid of customerIds) {
    const gid = ownGroup.get(cid);
    const members = gid ? (groupMembers.get(gid) || [cid]) : [cid];
    expand.set(cid, members);
    for (const m of members) allOrderCustomerIds.add(m);
  }

  // 3) Single orders query covering all expanded customer ids
  const { data: orders } = await admin.from("orders")
    .select("customer_id, total_cents, financial_status, created_at")
    .in("customer_id", [...allOrderCustomerIds]);

  // Bucket orders by customer_id
  const ordersByCust = new Map<string, { total_cents: number; financial_status: string | null; created_at: string }[]>();
  for (const o of orders || []) {
    const arr = ordersByCust.get(o.customer_id as string) || [];
    arr.push({ total_cents: o.total_cents || 0, financial_status: o.financial_status, created_at: o.created_at });
    ordersByCust.set(o.customer_id as string, arr);
  }

  // Roll up per input customer (combining their group's members)
  for (const cid of customerIds) {
    const stats: CustomerStats = { ltv_cents: 0, total_orders: 0, first_order_at: null, last_order_at: null };
    for (const memberId of expand.get(cid) || [cid]) {
      for (const o of ordersByCust.get(memberId) || []) {
        stats.total_orders++;
        if (o.financial_status !== "refunded") stats.ltv_cents += o.total_cents;
        if (!stats.first_order_at || o.created_at < stats.first_order_at) stats.first_order_at = o.created_at;
        if (!stats.last_order_at || o.created_at > stats.last_order_at) stats.last_order_at = o.created_at;
      }
    }
    out.set(cid, stats);
  }

  return out;
}
