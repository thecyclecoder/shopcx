// Shoptics → ShopCX migration, Phase 2 (shadow). Faithful port of Shoptics'
// product/BOM/Amazon mapping RESOLVERS — the crown-jewel lookup layer that maps an
// external order line (Amazon ASIN/seller-SKU, 3PL sku, Shopify productId-variantId)
// to a QuickBooks item, and rolls a bundle's cost up through its BOM.
//
// Ported verbatim from Shoptics src/lib/sync-engine.ts (resolveProductByMapping) +
// src/app/api/amazon/margin/route.ts (the seller_sku→ASIN→product two-hop + BOM cost
// rollup). Rewritten as PURE functions over the ported qb_* rows so they run in shadow
// (no DB, no live API) and reconcile offline against fixtures/shoptics-golden.
// See docs/brain/lifecycles/shoptics-migration.md.

export interface SkuMapping {
  external_id: string;
  source: string; // 'amazon' | '3pl' | 'shopify' | 'manual'
  product_id: string;
  unit_multiplier?: number | null;
  active: boolean;
}
export interface ExternalSku {
  external_id: string; // the ASIN, for amazon rows
  source: string;
  seller_sku?: string | null;
}
export interface QbItem {
  id: string;
  quickbooks_name: string;
  item_type: string; // 'inventory' | 'bundle'
  unit_cost?: number | null;
  revenue_account_id?: string | null;
  revenue_account_name?: string | null;
}
export interface BomRow {
  parent_id: string;
  component_id: string;
  quantity: number;
}

/**
 * THE product resolver (Shoptics sync-engine.ts:43). Single active-filtered lookup by
 * (external_id, source). Shopify callers pass `${productId}-${variantId}` as external_id
 * (load-bearing — NOT the bare sku); internal orders use source '3pl'. Returns product_id
 * or null. `mappings` is the ported qb_sku_mappings set.
 */
export function resolveProductByMapping(
  externalId: string,
  source: string,
  mappings: SkuMapping[],
): string | null {
  const hit = mappings.find(
    (m) => m.external_id === externalId && m.source === source && m.active,
  );
  return hit?.product_id ?? null;
}

/**
 * Amazon resolution as the sync-engine does it (lines 299-300 / 490-491): try the ASIN
 * first, then fall back to the seller-SKU — both against source 'amazon'. (Shoptics maps
 * ASINs directly in sku_mappings; some rows are keyed by seller-SKU instead.)
 */
export function resolveAmazon(
  asin: string | null | undefined,
  sellerSku: string | null | undefined,
  mappings: SkuMapping[],
): string | null {
  return (
    (asin ? resolveProductByMapping(asin, "amazon", mappings) : null) ||
    (sellerSku ? resolveProductByMapping(sellerSku, "amazon", mappings) : null)
  );
}

/**
 * The Amazon margin route's TWO-HOP (margin/route.ts:110-133,194-197): a seller_sku that
 * isn't itself a mapping key resolves via external_skus (seller_sku → external_id/ASIN) →
 * sku_mappings (ASIN → product). external_skus is the silent dependency that bridges the gap.
 * Returns { productId, multiplier } or null.
 */
export function resolveAmazonSellerSkuTwoHop(
  sellerSku: string,
  externalSkus: ExternalSku[],
  mappings: SkuMapping[],
): { productId: string; multiplier: number } | null {
  const skuToAsin = new Map<string, string>();
  for (const es of externalSkus) {
    if (es.source === "amazon" && es.seller_sku) skuToAsin.set(es.seller_sku, es.external_id);
  }
  const asinToProduct = new Map<string, { productId: string; multiplier: number }>();
  for (const m of mappings) {
    if (m.source === "amazon" && m.active) {
      asinToProduct.set(m.external_id, { productId: m.product_id, multiplier: m.unit_multiplier || 1 });
    }
  }
  const asin = skuToAsin.get(sellerSku);
  const mapping = asin ? asinToProduct.get(asin) : undefined;
  return mapping ?? null;
}

/**
 * Bundle cost rollup (margin/route.ts:150-169). For a bundle item, sum each component's
 * unit_cost × BOM quantity from product_bom (multi-parent source of truth). A missing
 * component cost marks the rollup `incomplete` (matches Shoptics' behavior). Non-bundle
 * items return their own unit_cost.
 */
export function rollUpBomCost(
  item: QbItem,
  items: QbItem[],
  bom: BomRow[],
): { cost: number | null; incomplete: boolean } {
  if (item.item_type !== "bundle") {
    return { cost: item.unit_cost ?? null, incomplete: item.unit_cost == null };
  }
  const byId = new Map(items.map((p) => [p.id, p]));
  const components = bom.filter((b) => b.parent_id === item.id);
  if (components.length === 0) return { cost: null, incomplete: true };
  let total = 0;
  let incomplete = false;
  for (const comp of components) {
    const c = byId.get(comp.component_id);
    if (c?.unit_cost != null) total += Number(c.unit_cost) * Number(comp.quantity);
    else incomplete = true;
  }
  return { cost: total, incomplete };
}
