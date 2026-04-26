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
 * Batch version — fetches stats for many customers at once with a single
 * orders query. Use this on list/table views to avoid N+1.
 *
 * Note: this version does NOT expand linked accounts. Each customer_id is
 * scoped to its own orders only. Use getCustomerStats for the linked-aware
 * single-customer view.
 */
export async function getCustomerStatsBatch(customerIds: string[]): Promise<Map<string, CustomerStats>> {
  const out = new Map<string, CustomerStats>();
  if (customerIds.length === 0) return out;
  const admin = createAdminClient();
  const { data: orders } = await admin.from("orders")
    .select("customer_id, total_cents, financial_status, created_at")
    .in("customer_id", customerIds);
  for (const id of customerIds) {
    out.set(id, { ltv_cents: 0, total_orders: 0, first_order_at: null, last_order_at: null });
  }
  for (const o of orders || []) {
    const s = out.get(o.customer_id as string);
    if (!s) continue;
    s.total_orders++;
    if (o.financial_status !== "refunded") s.ltv_cents += o.total_cents || 0;
    if (!s.first_order_at || o.created_at < s.first_order_at) s.first_order_at = o.created_at;
    if (!s.last_order_at || o.created_at > s.last_order_at) s.last_order_at = o.created_at;
  }
  return out;
}
