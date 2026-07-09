/**
 * Customer stats (LTV, total_orders, first/last order dates) computed live from
 * the orders table. We previously stored these as denormalized columns on the
 * customers row, but they kept drifting (Shopify webhooks with missing/zero
 * order_count would zero them out). Always read via this helper.
 *
 * Aggregation runs SERVER-SIDE in the `get_customer_stats_batch(p_customer_ids uuid[])`
 * RPC (supabase/migrations/20260708130000_customer_stats_batch_rpc.sql). The previous
 * implementation expanded customer_links groups in JS then did one unbounded
 * `.in('customer_id', [...])` over orders and summed in JS — that read silently
 * truncated at Supabase's 1000-row response cap, so the customers-list LTV/order-count
 * columns were undercounted whenever a page's customers had >1000 orders between them
 * (the same bug class as the estimate_sub_ltv incident). The RPC sees every row.
 *
 * Semantics (unchanged from the JS version — pure truncation fix):
 *   - LTV excludes ONLY financial_status = 'refunded' (lowercase). NULL counts, and — as before —
 *     uppercase 'REFUNDED'/'PARTIALLY_REFUNDED' also still count (a known casing gap, tracked separately).
 *   - total_orders counts all orders; first/last_order_at are min/max(created_at) over all orders.
 *   - Linked accounts (same customer_links group) roll up into each member's totals.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export interface CustomerStats {
  ltv_cents: number;
  total_orders: number;
  first_order_at: string | null;
  last_order_at: string | null;
}

interface StatsRpcRow {
  input_customer_id: string;
  ltv_cents: number | string | null;
  total_orders: number | string | null;
  first_order_at: string | null;
  last_order_at: string | null;
}

const ZERO: CustomerStats = { ltv_cents: 0, total_orders: 0, first_order_at: null, last_order_at: null };

/**
 * Batch version — one round trip, aggregated server-side, cap-free. Rolls up linked-account
 * totals (a profile in a 3-account group sees combined orders/LTV across all 3). Returns a
 * Map with an entry for every input id (zeroed when the customer has no orders).
 */
export async function getCustomerStatsBatch(customerIds: string[]): Promise<Map<string, CustomerStats>> {
  const out = new Map<string, CustomerStats>();
  if (customerIds.length === 0) return out;
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("get_customer_stats_batch", { p_customer_ids: customerIds });
  if (error) throw new Error(`get_customer_stats_batch RPC failed: ${error.message}`);

  for (const r of (data ?? []) as StatsRpcRow[]) {
    out.set(r.input_customer_id, {
      ltv_cents: Number(r.ltv_cents) || 0,
      total_orders: Number(r.total_orders) || 0,
      first_order_at: r.first_order_at,
      last_order_at: r.last_order_at,
    });
  }
  // The RPC returns a row per input, but stay defensive so callers can always .get(id).
  for (const cid of customerIds) if (!out.has(cid)) out.set(cid, { ...ZERO });
  return out;
}

/**
 * Single-customer stats. Delegates to the batch RPC (shared SQL, same cap-free semantics).
 */
export async function getCustomerStats(customerId: string): Promise<CustomerStats> {
  const stats = await getCustomerStatsBatch([customerId]);
  return stats.get(customerId) ?? { ...ZERO };
}
