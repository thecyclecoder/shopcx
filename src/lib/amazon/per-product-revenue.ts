// Per-product Amazon non-renewal revenue — the AcqROAS source (Phase 4).
// Reads daily_amazon_product_snapshots (written beside the aggregate by processOrderReport) and sums
// the NON-RENEWAL checkout family for a linked-product group over a date window. This is the Amazon
// halo that growth-acquisition-roas-spine credits to Meta spend.
//
// Non-renewal = one_time + sns_checkout. `recurring` (Amazon Subscribe & Save auto-renewals) is
// EXCLUDED — renewals are not acquisition. Mirrors the on-site bucketOrder non-renewal family.

import { createAdminClient } from "@/lib/supabase/admin";

// Amazon order_bucket values that count as new-customer acquisition (renewals excluded).
export const AMAZON_NON_RENEWAL_BUCKETS = ["one_time", "sns_checkout"] as const;

export interface AmazonProductRevenue {
  grossCents: number;
  netCents: number;
  orderCount: number;
  units: number;
  byProduct: Record<string, { grossCents: number; netCents: number; units: number; orderCount: number }>;
}

// Sum Amazon non-renewal revenue for the given product_ids over [startDate, endDate] (inclusive, YYYY-MM-DD).
// Pass the full linked-group product_ids; the caller rolls the group total up from byProduct if needed.
export async function getAmazonNonRenewalRevenue(params: {
  workspaceId: string;
  productIds: string[];
  startDate: string;
  endDate: string;
}): Promise<AmazonProductRevenue> {
  const admin = createAdminClient();
  const out: AmazonProductRevenue = { grossCents: 0, netCents: 0, orderCount: 0, units: 0, byProduct: {} };
  if (!params.productIds.length) return out;

  const { data: rows } = await admin
    .from("daily_amazon_product_snapshots")
    .select("product_id, gross_revenue_cents, net_revenue_cents, order_count, units")
    .eq("workspace_id", params.workspaceId)
    .in("product_id", params.productIds)
    .in("order_bucket", AMAZON_NON_RENEWAL_BUCKETS as unknown as string[])
    .gte("snapshot_date", params.startDate)
    .lte("snapshot_date", params.endDate);

  for (const r of rows || []) {
    const pid = r.product_id as string;
    out.grossCents += r.gross_revenue_cents || 0;
    out.netCents += r.net_revenue_cents || 0;
    out.orderCount += r.order_count || 0;
    out.units += r.units || 0;
    const p = (out.byProduct[pid] ||= { grossCents: 0, netCents: 0, units: 0, orderCount: 0 });
    p.grossCents += r.gross_revenue_cents || 0;
    p.netCents += r.net_revenue_cents || 0;
    p.units += r.units || 0;
    p.orderCount += r.order_count || 0;
  }

  return out;
}
