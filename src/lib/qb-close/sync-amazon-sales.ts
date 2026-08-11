/**
 * qb-close/sync-amazon-sales — Amazon SHIPPED units per ASIN per day into
 * [[../tables/qb_amazon_sales_snapshots]], the Amazon sales-receipt (COGS) driver and the audit's
 * Amazon burn term. Owner: [[../functions/cfo]] (Grace).
 *
 * ⭐ **`units_shipped` ≠ units ordered, and the difference is large.** ShopCX's existing
 * `daily_amazon_product_snapshots` (via `amazon/sync-orders.ts`) deliberately counts Shipped +
 * Shipping + **Pending**, bucketed by purchase date, because it answers a demand question. The
 * close answers an INVENTORY question: only units that actually left a warehouse may burn stock
 * and carry COGS. For July 2026 the two differ by 35% — **803 units ordered vs 597 shipped** —
 * so the analytics table can never substitute here.
 *
 * This module therefore re-parses the same SP-API report with the close's own rule:
 * `order-status ∈ {Shipped, Shipping}`, excluding Pending and Cancelled.
 *
 * Promotion bucketing mirrors the proven implementation: `FBA Subscribe & Save Discount` →
 * recurring, `Subscribe and Save Promotion V2` → sns_checkout, else one_time. Amazon writes "&"
 * in the report data, so both spellings are matched.
 *
 * Idempotent: upserts on `(workspace_id, asin, sale_date)`.
 * See docs/brain/libraries/qb-close-sync-amazon-sales.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { requestReport, pollReportStatus, downloadReport } from "@/lib/amazon/sync-orders";

export interface AmazonSalesSyncResult {
  table: string;
  rows: number;
  unitsShipped: number;
  unitsExcluded: number;
  note?: string;
}

/** Statuses that represent stock having LEFT the warehouse. */
const SHIPPED_STATUSES = new Set(["shipped", "shipping"]);

function bucketOf(promoIds: string): "recurring" | "sns_checkout" | "one_time" {
  if (promoIds.includes("FBA Subscribe & Save Discount") || promoIds.includes("FBA Subscribe and Save Discount")) return "recurring";
  if (promoIds.includes("Subscribe and Save Promotion V2")) return "sns_checkout";
  return "one_time";
}

interface Agg {
  units: number; revenue: number;
  recurringUnits: number; recurringRevenue: number;
  snsUnits: number; snsRevenue: number;
  oneTimeUnits: number; oneTimeRevenue: number;
  pending: number; cancelled: number;
  sellerSku: string | null; productName: string | null;
}

/**
 * Parse the flat-file orders TSV into (asin, sale_date) aggregates using the CLOSE's rule.
 * Exported for testing — the shipped/pending split is the whole point of this module.
 */
export function parseShippedUnits(tsv: string): { byKey: Map<string, Agg>; excluded: number } {
  const lines = tsv.split("\n");
  const byKey = new Map<string, Agg>();
  let excluded = 0;
  if (lines.length < 2) return { byKey, excluded };

  const headers = lines[0].split("\t");
  const idx = (n: string) => headers.indexOf(n);
  const iAsin = idx("asin"), iSku = idx("sku"), iQty = idx("quantity"), iPrice = idx("item-price");
  const iDate = idx("purchase-date"), iPromo = idx("promotion-ids"), iStatus = idx("order-status"), iName = idx("product-name");

  for (let i = 1; i < lines.length; i++) {
    // ⭐ Do NOT trim the line before splitting. A row whose first or last column is empty — an
    // absent order id, no promotion ids — begins or ends with a TAB, and trimming strips it,
    // shifting every column left by one. That silently reads `item-price` as `quantity` and
    // garbage as `order-status`. Only strip a trailing CR, and test blankness on a copy.
    const raw = lines[i].replace(/\r$/, "");
    if (!raw.trim()) continue;
    const c = raw.split("\t");
    const qty = parseInt(c[iQty]) || 0;
    if (!qty) continue;

    const status = (c[iStatus] ?? "").toLowerCase();
    if (!SHIPPED_STATUSES.has(status)) {
      // Pending and Cancelled never burned stock. Counted so the caller can report the gap
      // rather than silently diverging from the analytics table.
      excluded += qty;
      continue;
    }

    const asin = c[iAsin] ?? "";
    if (!asin) continue;
    const saleDate = (c[iDate] ?? "").slice(0, 10);
    if (!saleDate) continue;

    const key = `${asin}|${saleDate}`;
    const cur = byKey.get(key) ?? {
      units: 0, revenue: 0, recurringUnits: 0, recurringRevenue: 0, snsUnits: 0, snsRevenue: 0,
      oneTimeUnits: 0, oneTimeRevenue: 0, pending: 0, cancelled: 0,
      sellerSku: c[iSku] ?? null, productName: iName >= 0 ? (c[iName] ?? null) : null,
    };
    const price = parseFloat(c[iPrice]) || 0;
    cur.units += qty;
    cur.revenue += price;
    const b = bucketOf(c[iPromo] ?? "");
    if (b === "recurring") { cur.recurringUnits += qty; cur.recurringRevenue += price; }
    else if (b === "sns_checkout") { cur.snsUnits += qty; cur.snsRevenue += price; }
    else { cur.oneTimeUnits += qty; cur.oneTimeRevenue += price; }
    byKey.set(key, cur);
  }
  return { byKey, excluded };
}

/** Wait for a requested report to finish. SP-API report generation is asynchronous. */
async function waitForReport(
  connectionId: string,
  marketplaceId: string,
  reportId: string,
  maxWaitMs = 180_000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const { status, documentId } = await pollReportStatus(connectionId, marketplaceId, reportId);
    if (status === "DONE" && documentId) return downloadReport(connectionId, marketplaceId, documentId);
    if (status === "CANCELLED" || status === "FATAL") throw new Error(`Amazon report ${status}`);
    if (Date.now() - started > maxWaitMs) throw new Error(`Amazon report timed out after ${Math.round(maxWaitMs / 1000)}s (status ${status})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** Sync Amazon shipped units for [start, end] into qb_amazon_sales_snapshots. */
export async function syncAmazonSalesForClose(
  admin: SupabaseClient,
  workspaceId: string,
  start: string,
  end: string,
): Promise<AmazonSalesSyncResult> {
  const { data: conns } = await admin
    .from("amazon_connections").select("id, marketplace_id").eq("workspace_id", workspaceId);
  if (!conns?.length) return { table: "qb_amazon_sales_snapshots", rows: 0, unitsShipped: 0, unitsExcluded: 0, note: "no amazon_connections" };

  const merged = new Map<string, Agg>();
  let excluded = 0;
  for (const c of conns) {
    const reportId = await requestReport(c.id, c.marketplace_id, `${start}T00:00:00Z`, `${end}T23:59:59Z`);
    const tsv = await waitForReport(c.id, c.marketplace_id, reportId);
    const parsed = parseShippedUnits(tsv);
    excluded += parsed.excluded;
    for (const [k, v] of parsed.byKey) {
      const cur = merged.get(k);
      if (!cur) { merged.set(k, v); continue; }
      cur.units += v.units; cur.revenue += v.revenue;
      cur.recurringUnits += v.recurringUnits; cur.recurringRevenue += v.recurringRevenue;
      cur.snsUnits += v.snsUnits; cur.snsRevenue += v.snsRevenue;
      cur.oneTimeUnits += v.oneTimeUnits; cur.oneTimeRevenue += v.oneTimeRevenue;
    }
  }

  const rows = [...merged.entries()].map(([key, v]) => {
    const [asin, sale_date] = key.split("|");
    return {
      workspace_id: workspaceId, asin, seller_sku: v.sellerSku, product_name: v.productName, sale_date,
      units_shipped: v.units, revenue: Math.round(v.revenue * 100) / 100,
      units_pending: 0, units_cancelled: 0,
      recurring_units: v.recurringUnits, recurring_revenue: Math.round(v.recurringRevenue * 100) / 100,
      sns_checkout_units: v.snsUnits, sns_checkout_revenue: Math.round(v.snsRevenue * 100) / 100,
      one_time_units: v.oneTimeUnits, one_time_revenue: Math.round(v.oneTimeRevenue * 100) / 100,
      snapshot_taken_at: new Date().toISOString(),
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("qb_amazon_sales_snapshots").upsert(rows.slice(i, i + 500), { onConflict: "workspace_id,asin,sale_date" });
    if (error) throw new Error(`qb_amazon_sales_snapshots: ${error.message}`);
  }

  const unitsShipped = rows.reduce((a, r) => a + r.units_shipped, 0);
  return {
    table: "qb_amazon_sales_snapshots",
    rows: rows.length,
    unitsShipped,
    unitsExcluded: excluded,
    note: `${excluded} unit(s) excluded as Pending/Cancelled — they never left a warehouse`,
  };
}
