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
import { bucketOrder } from "@/lib/order-bucketing";
import { isMetaUtm } from "@/lib/utm";

// bucketOrder values that count as new-customer acquisition (renewals + drafts excluded).
export const ONSITE_NON_RENEWAL_BUCKETS = ["new_sub", "one_time"] as const;

export interface OnsiteProductRevenue {
  grossCents: number;
  orderCount: number; // distinct non-renewal orders that contributed ≥1 matching line
  units: number;
  byProduct: Record<string, { grossCents: number; units: number; orderCount: number }>;
}

interface OrderLine {
  variant_id?: string | number | null;
  price_cents?: number | null;
  quantity?: number | null;
}

interface OrderRow {
  source_name: string | null;
  tags: string | string[] | null;
  subscription_id: string | null;
  attributed_utm_source: string | null;
  line_items: OrderLine[] | null;
}

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

  // 1. Resolve the group's product_ids → the set of Shopify variant ids, keeping variant→product.
  const variantToProduct = new Map<string, string>();
  {
    let offset = 0;
    while (true) {
      const { data } = await admin
        .from("product_variants")
        .select("shopify_variant_id, product_id")
        .eq("workspace_id", params.workspaceId)
        .in("product_id", params.productIds)
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      for (const v of data) {
        if (v.shopify_variant_id) variantToProduct.set(String(v.shopify_variant_id), v.product_id as string);
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  if (variantToProduct.size === 0) return out;

  // 2. The snapshot/ROAS bucketing reads order_source_mapping; pass it to bucketOrder so internal
  // storefront subs/renewals bucket the same way they do everywhere else.
  const { data: wsMapRow } = await admin
    .from("workspaces").select("order_source_mapping").eq("id", params.workspaceId).maybeSingle();
  const sourceMapping = (wsMapRow?.order_source_mapping || {}) as Record<string, string>;

  // 3. Walk orders in the window (paginated), bucket each, sum matching non-renewal lines.
  // created_at is a UTC timestamptz; the window is given in Central-time YYYY-MM-DD (matching the ROAS
  // route's snapshot boundaries), so convert [start 00:00, end+1 00:00) Central → UTC (CDT = +05:00).
  const utcStart = `${params.startDate}T05:00:00Z`;
  const dayAfterEnd = (() => { const d = new Date(`${params.endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const utcEnd = `${dayAfterEnd}T05:00:00Z`;

  let offset = 0;
  while (true) {
    const { data } = await admin
      .from("orders")
      .select("source_name, tags, subscription_id, attributed_utm_source, line_items")
      .eq("workspace_id", params.workspaceId)
      .gte("created_at", utcStart)
      .lt("created_at", utcEnd)
      .order("created_at", { ascending: true })
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;

    for (const o of data as OrderRow[]) {
      const bucket = bucketOrder(o, sourceMapping);
      if (bucket !== "new_sub" && bucket !== "one_time") continue; // renewals + drafts excluded
      if (params.metaOnlyUtm && !isMetaUtm(o.attributed_utm_source)) continue;

      const productsTouched = new Set<string>();
      for (const li of o.line_items || []) {
        const vid = li.variant_id != null ? String(li.variant_id) : "";
        const pid = vid ? variantToProduct.get(vid) : undefined;
        if (!pid) continue;
        const qty = li.quantity || 0;
        const cents = (li.price_cents || 0) * qty;
        out.grossCents += cents;
        out.units += qty;
        const p = (out.byProduct[pid] ||= { grossCents: 0, units: 0, orderCount: 0 });
        p.grossCents += cents;
        p.units += qty;
        if (!productsTouched.has(pid)) p.orderCount += 1; // count the order once per product it touched
        productsTouched.add(pid);
      }
      if (productsTouched.size) out.orderCount += 1;
    }

    if (data.length < 1000) break;
    offset += 1000;
  }

  return out;
}
