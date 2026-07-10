// Shoptics → ShopCX migration, Phase 2/3 (shadow). Faithful port of the month-end
// zero-dollar SalesReceipt builder (Shoptics api/qb/sales-receipt/route.ts) — one $0
// receipt per channel (Amazon / Shopify / Internal) whose only job is to move COGS: QB
// auto-expands a bundle's BOM for COGS via GroupLineDetail; standalone items use
// SalesItemLineDetail at qty/$0. Pure functions over the ported snapshots + mappings —
// posts nothing. See docs/brain/lifecycles/shoptics-migration.md.

import type { SkuMapping } from "./resolvers";

export interface QbReceiptItem { id: string; quickbooks_id: string; item_type: string; }
export type SalesByProduct = Map<string, { product_id: string; units: number }>;

/** Amazon units → product (asin → sku_mappings amazon → product, × unit_multiplier). */
export function aggregateAmazonUnits(rows: { asin: string; units_shipped: number }[], mappings: SkuMapping[]): SalesByProduct {
  const lookup = new Map<string, { product_id: string; multiplier: number }>();
  for (const m of mappings) if (m.source === "amazon" && m.active) lookup.set(m.external_id, { product_id: m.product_id, multiplier: m.unit_multiplier || 1 });
  const out: SalesByProduct = new Map();
  for (const r of rows) {
    const mp = lookup.get(r.asin); if (!mp) continue;
    if (!out.has(mp.product_id)) out.set(mp.product_id, { product_id: mp.product_id, units: 0 });
    out.get(mp.product_id)!.units += r.units_shipped * mp.multiplier;
  }
  return out;
}

/** Shopify units → product (variant_id → sku_mappings shopify → product, × unit_multiplier). */
export function aggregateShopifyUnits(rows: { variant_id: string; units_sold: number }[], mappings: SkuMapping[]): SalesByProduct {
  const lookup = new Map<string, { product_id: string; multiplier: number }>();
  for (const m of mappings) if (m.source === "shopify" && m.active) lookup.set(m.external_id, { product_id: m.product_id, multiplier: m.unit_multiplier || 1 });
  const out: SalesByProduct = new Map();
  for (const r of rows) {
    const mp = lookup.get(r.variant_id); if (!mp) continue;
    if (!out.has(mp.product_id)) out.set(mp.product_id, { product_id: mp.product_id, units: 0 });
    out.get(mp.product_id)!.units += r.units_sold * mp.multiplier;
  }
  return out;
}

/** Internal units → product (already resolved to product_id with multiplier applied at sync time). */
export function aggregateInternalUnits(rows: { product_id: string | null; units: number }[]): SalesByProduct {
  const out: SalesByProduct = new Map();
  for (const r of rows) {
    if (!r.product_id) continue;
    if (!out.has(r.product_id)) out.set(r.product_id, { product_id: r.product_id, units: 0 });
    out.get(r.product_id)!.units += r.units;
  }
  return out;
}

export interface ReceiptLine {
  detailType: "GroupLineDetail" | "SalesItemLineDetail";
  itemRef: string; // quickbooks_id (GroupItemRef for bundles, ItemRef otherwise)
  qty: number;
}

/** Build the $0 SalesReceipt lines for a channel: bundle → GroupLineDetail (QB expands BOM
 *  for COGS), else SalesItemLineDetail at qty/$0. Skips products with units ≤ 0. */
export function buildSalesReceiptLines(salesByProduct: SalesByProduct, items: QbReceiptItem[]): ReceiptLine[] {
  const byId = new Map(items.map((p) => [p.id, p]));
  const lines: ReceiptLine[] = [];
  for (const [productId, sales] of salesByProduct) {
    const product = byId.get(productId);
    if (!product || sales.units <= 0) continue;
    lines.push({
      detailType: product.item_type === "bundle" ? "GroupLineDetail" : "SalesItemLineDetail",
      itemRef: product.quickbooks_id,
      qty: sales.units,
    });
  }
  return lines;
}
