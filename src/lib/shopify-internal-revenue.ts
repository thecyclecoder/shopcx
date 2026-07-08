// Per-product on-site (Shopify + internal storefront) NON-RENEWAL revenue — the on-site half of
// AcqROAS (docs/brain/specs/growth-acquisition-roas-spine.md Phase 1). Mirrors the Amazon resolver's
// shape (src/lib/amazon/per-product-revenue.ts): sums LINE-ITEM revenue for a linked-product group
// over a date window, counting only orders that bucket as non-renewal.
//
// Non-renewal = the canonical bucketOrder checkout family (`new_sub` + `one_time`); `recurring`
// (renewals) and `replacement` (drafts) are EXCLUDED — renewals are not acquisition. We reuse, never
// re-implement, bucketOrder so this can't drift from the snapshot cron / ROAS route.
//
// Line ↔ product match: a line item's `variant_id` (the Shopify variant id) is resolved through
// `product_variants.shopify_variant_id → product_id`; a line counts only when its product_id is in the
// group. Revenue is `price_cents × quantity` summed across the matching lines (NOT the order total —
// the order may contain non-group items, e.g. the accessory mug).

import { createAdminClient } from "@/lib/supabase/admin";

// bucketOrder values that count as new-customer acquisition (renewals + drafts excluded).
export const ONSITE_NON_RENEWAL_BUCKETS = ["new_sub", "one_time"] as const;

export interface OnsiteProductRevenue {
  grossCents: number;
  orderCount: number; // distinct non-renewal orders that contributed ≥1 matching line
  units: number;
  byProduct: Record<string, { grossCents: number; units: number; orderCount: number }>;
}

// Phase 4 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
// Prior implementation paginated the orders table (line_items JSONB) to app and
// replayed bucketOrder + variantToProduct + Meta-UTM filter in JS on every call —
// called PER LINKED GROUP from blended-cac-ltv.ts, this was the biggest single
// egress site the audit flagged. The variant→product join, bucket predicate,
// and Meta-UTM family filter now run inside public.onsite_nonrenewal_revenue
// (supabase/migrations/20261005160000_phase4_crisis_growth_rpcs.sql). Returns
// one aggregate row per matched product; the outer aggregate (grossCents,
// units, orderCount) is derived from the per-product rows the RPC returns.

// Sum on-site non-renewal line-item revenue for the given product_ids over [startDate, endDate]
// (inclusive, YYYY-MM-DD). Pass the full linked-group product_ids; `byProduct` carries the split.
//
// `metaOnlyUtm` (default false) implements the inverse of the spec's "non-utm sales are Meta-derivative"
// assumption: when true, only orders whose attributed_utm_source is Meta are counted. The baseline and
// the default AcqROAS assumption count ALL non-renewal sales (metaOnlyUtm=false).
export async function getShopifyInternalNonRenewalRevenue(params: {
  workspaceId: string;
  productIds: string[];
  startDate: string;
  endDate: string;
  metaOnlyUtm?: boolean;
}): Promise<OnsiteProductRevenue> {
  const admin = createAdminClient();
  const out: OnsiteProductRevenue = { grossCents: 0, orderCount: 0, units: 0, byProduct: {} };
  if (!params.productIds.length) return out;

  const { data: rows } = await admin.rpc("onsite_nonrenewal_revenue", {
    p_workspace: params.workspaceId,
    p_product_ids: params.productIds,
    p_start: params.startDate,
    p_end: params.endDate,
    p_meta_only: !!params.metaOnlyUtm,
  });

  const rpcRows = (rows ?? []) as Array<{
    product_id: string | null;
    gross_cents: number | string | null;
    units: number | string | null;
    order_count: number | string | null;
  }>;

  // The RPC emits per-product rows PLUS a synthetic row with product_id IS NULL
  // carrying the overall aggregate (grossCents + units + DISTINCT order_count).
  // Splitting them here keeps the outer + byProduct semantics identical to the
  // prior JS implementation — blended-cac-ltv reads `newCustomers = onsite.orderCount`.
  for (const r of rpcRows) {
    const gross = Number(r.gross_cents ?? 0) || 0;
    const units = Number(r.units ?? 0) || 0;
    const oc = Number(r.order_count ?? 0) || 0;
    if (r.product_id === null) {
      out.grossCents = gross;
      out.units = units;
      out.orderCount = oc;
    } else {
      out.byProduct[r.product_id] = { grossCents: gross, units, orderCount: oc };
    }
  }

  return out;
}
