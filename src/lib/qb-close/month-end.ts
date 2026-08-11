/**
 * qb-close/month-end — assembles a month's close inputs from **ShopCX's own tables** and drives
 * the ported builders ([[journal-entry]] / [[sales-receipt]] / [[inventory-audit]]) in SHADOW.
 *
 * This is the piece the June 1:1 proof never had: that run read `fixtures/shoptics-golden/*.json`
 * dumped out of the Shoptics DB, so it validated the ENGINE but not that ShopCX holds the data.
 * Everything here reads `qb_*` tables in ShopCX (created by
 * `20261213120000_qb_close_source_tables.sql`).
 *
 * POSTS NOTHING. It returns the five QBO artifacts as plain data; a caller decides whether to
 * post. See docs/brain/lifecycles/shoptics-migration.md.
 *
 * Three corrections are baked in here rather than in the builders, because they are decisions
 * about WHICH SOURCE COLUMN is physical truth — each was proven against the July 2026 close:
 *
 *  1. Shopify burn = `units_sold + refund_units`. `units_sold` excludes fully-refunded orders,
 *     but those units shipped and are not guaranteed restockable (CEO 2026-08-11).
 *  2. 3PL physical = `quantity_on_hand`, NOT `quantity_available` — `available` nets off units
 *     COMMITTED to unshipped orders, which are still on the shelf and still ours at the cutoff.
 *     Reading `available` booked owned stock as shrinkage (+1,701-unit swing in July).
 *  3. FBA physical = `fulfillable + transit` ONLY. `quantity_transit` is DEFINED as
 *     inboundWorking + inbound + reserved, so adding either double-counts (verified across
 *     3,240 rows: transit == inbound + reserved wherever inboundWorking is 0).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildJournalEntryLines,
  type JournalEntryInputs,
  type JournalEntryResult,
  type ProcessorTotals,
  type RevAcct,
  type ShopifyOrder,
} from "./journal-entry";
import {
  aggregateAmazonUnits,
  aggregateShopifyUnits,
  aggregateInternalUnits,
  buildSalesReceiptLines,
  type QbReceiptItem,
  type ReceiptLine,
} from "./sales-receipt";
import {
  computeAuditVariances,
  buildInventoryAdjustmentLines,
  type AdjustmentLine,
  type VarianceRow,
  type AuditBomRow,
  type AuditInputs,
  type AuditMapping,
  type AuditProduct,
} from "./inventory-audit";
import type { SkuMapping } from "./resolvers";

export interface MonthEndArtifacts {
  month: string;
  journalEntry: JournalEntryResult;
  receipts: { amazon: ReceiptLine[]; shopify: ReceiptLine[]; internal: ReceiptLine[] };
  inventoryAdjustment: AdjustmentLine[];
  /** Every audited row incl. the MEASURED physical — what step 7 compares post-close QB against. */
  auditRows: VarianceRow[];
  meta: {
    priorMonth: string;
    qbBasisRows: number;
    fbaSnapshotDate: string | null;
    tplSnapshotDate: string | null;
    shopifyOrderCount: number;
    receivedItemCount: number;
  };
}

/** Page past PostgREST's 1000-row cap. A silent truncation here would understate a whole month. */
async function all<T>(
  admin: SupabaseClient,
  table: string,
  build: (q: ReturnType<SupabaseClient["from"]>) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const q = build(admin.from(table)) as {
      range: (a: number, b: number) => Promise<{ data: T[] | null; error: { message: string } | null }>;
    };
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

function priorMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
}
function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

export interface BuildMonthEndOptions {
  workspaceId: string;
  month: string;
  admin: SupabaseClient;
  /** Live Shopify orders for the month — the JE's revenue/tax/shipping/discount basis. */
  orders: ShopifyOrder[];
  /** product_id → units received via QB Bill/Purchase in the period. */
  receivedByProduct?: Map<string, number>;
}

/** Assemble + run all five artifact builders in shadow. Writes nothing, posts nothing. */
export async function buildMonthEndArtifacts(opts: BuildMonthEndOptions): Promise<MonthEndArtifacts> {
  const { workspaceId: ws, month, admin, orders, receivedByProduct = new Map() } = opts;
  const prior = priorMonthOf(month);
  const { start, end } = monthBounds(month);

  const items = await all<{
    id: string; quickbooks_id: string; quickbooks_name: string; sku: string | null;
    item_type: string; product_category: string | null; unit_cost: number | null;
    revenue_account_id: string | null; revenue_account_name: string | null; active: boolean | null;
  }>(admin, "qb_items", (q) => q.select("*").eq("workspace_id", ws));

  const [accounts, gateways, skuMaps, bom, manual, shipProt] = await Promise.all([
    all<{ key: string; qb_id: string; qb_name: string }>(admin, "qb_account_mappings", (q) => q.select("*").eq("workspace_id", ws)),
    all<{ gateway_name: string; processor: string }>(admin, "qb_gateway_mappings", (q) => q.select("*").eq("workspace_id", ws)),
    all<{ external_id: string; source: string; product_id: string; unit_multiplier: number | null; active: boolean }>(
      admin, "qb_sku_mappings", (q) => q.select("*").eq("workspace_id", ws)),
    all<{ parent_id: string; component_id: string; quantity: number }>(admin, "qb_item_bom", (q) => q.select("*").eq("workspace_id", ws)),
    all<{ product_id: string; quantity: number; active: boolean }>(admin, "qb_manual_inventory", (q) => q.select("*").eq("workspace_id", ws)),
    all<{ shopify_product_id: string }>(admin, "qb_shipping_protection_products", (q) => q.select("*").eq("workspace_id", ws)),
  ]);

  const acct: Record<string, { value: string; name: string }> = {};
  for (const a of accounts) acct[a.key] = { value: String(a.qb_id), name: a.qb_name };
  const gatewayLookup = new Map(gateways.map((g) => [g.gateway_name, g.processor]));
  const mappings: SkuMapping[] = skuMaps.map((m) => ({
    external_id: m.external_id, source: m.source, product_id: m.product_id,
    unit_multiplier: m.unit_multiplier, active: m.active,
  }));
  const shopifyMappingLookup = new Map<string, string>();
  for (const m of mappings) if (m.source === "shopify" && m.active) shopifyMappingLookup.set(m.external_id, m.product_id);
  const productLookup = new Map<string, RevAcct>(
    items.map((i) => [i.id, { name: i.quickbooks_name, rev_acct_id: i.revenue_account_id, rev_acct_name: i.revenue_account_name }]),
  );
  const shippingProtectionIds = new Set(shipProt.map((r) => String(r.shopify_product_id)));

  // ── sales ──
  const amzSales = await all<{ asin: string; units_shipped: number }>(
    admin, "qb_amazon_sales_snapshots", (q) => q.select("asin, units_shipped").eq("workspace_id", ws).gte("sale_date", start).lte("sale_date", end));
  const shopSales = await all<{ variant_id: string; units_sold: number; refund_units: number }>(
    admin, "qb_shopify_sales_snapshots", (q) => q.select("variant_id, units_sold, refund_units").eq("workspace_id", ws).gte("sale_date", start).lte("sale_date", end));
  const intSales = await all<{
    product_id: string | null; units: number; gross_cents: number; order_total_cents: number;
    tax_cents: number; discount_cents: number; shipping_cents: number; line_index: number;
  }>(admin, "qb_internal_sales_snapshots", (q) => q.select("*").eq("workspace_id", ws).gte("sale_date", start).lte("sale_date", end));

  // correction 1 — refunded units still shipped, so they burn inventory
  const shopBurn = shopSales.map((r) => ({ variant_id: r.variant_id, units_sold: (r.units_sold ?? 0) + (r.refund_units ?? 0) }));

  // ── processors ──
  const procRows = await all<{ processor: string; gross_sales: number; processing_fees: number; refunds: number; chargebacks: number; adjustments: number }>(
    admin, "qb_payment_processor_summaries", (q) => q.select("*").eq("workspace_id", ws).eq("closing_month", month));
  const processors: Record<string, ProcessorTotals> = {};
  for (const p of procRows)
    processors[p.processor] = {
      gross: Number(p.gross_sales), fees: Number(p.processing_fees), refunds: Number(p.refunds),
      chargebacks: Number(p.chargebacks), adjustments: Number(p.adjustments),
    };

  // ── physical inventory at period end ──
  const fbaDateRow = await all<{ snapshot_date: string }>(
    admin, "qb_amazon_inventory_snapshots", (q) => q.select("snapshot_date").eq("workspace_id", ws).lte("snapshot_date", end).order("snapshot_date", { ascending: false }).limit(1));
  const tplDateRow = await all<{ snapshot_date: string }>(
    admin, "qb_tpl_inventory_snapshots", (q) => q.select("snapshot_date").eq("workspace_id", ws).lte("snapshot_date", end).order("snapshot_date", { ascending: false }).limit(1));
  const fbaDate = fbaDateRow[0]?.snapshot_date ?? null;
  const tplDate = tplDateRow[0]?.snapshot_date ?? null;

  const fbaByAsin = new Map<string, { fulfillable: number; transit: number }>();
  if (fbaDate) {
    const rows = await all<{ asin: string; quantity_fulfillable: number; quantity_transit: number }>(
      admin, "qb_amazon_inventory_snapshots", (q) => q.select("asin, quantity_fulfillable, quantity_transit").eq("workspace_id", ws).eq("snapshot_date", fbaDate));
    // correction 3 — transit already contains reserved + inbound; do NOT add them
    for (const r of rows) fbaByAsin.set(r.asin, { fulfillable: r.quantity_fulfillable ?? 0, transit: r.quantity_transit ?? 0 });
  }
  const tplBySku = new Map<string, number>();
  if (tplDate) {
    const rows = await all<{ sku: string; quantity_on_hand: number }>(
      admin, "qb_tpl_inventory_snapshots", (q) => q.select("sku, quantity_on_hand").eq("workspace_id", ws).eq("snapshot_date", tplDate));
    // correction 2 — on_hand, not available
    for (const r of rows) tplBySku.set(r.sku, r.quantity_on_hand ?? 0);
  }

  // ── opening book = prior month's month_end_post ──
  const bookRows = await all<{ product_id: string; quantity: number }>(
    admin, "qb_book_inventory_snapshots", (q) =>
      q.select("product_id, quantity").eq("workspace_id", ws).eq("closing_month", prior).eq("snapshot_type", "month_end_post"));
  const qbInventory = new Map<string, number>();
  for (const r of bookRows) qbInventory.set(r.product_id, Number(r.quantity));

  const manualByProduct = new Map<string, number>();
  for (const m of manual) if (m.active) manualByProduct.set(m.product_id, (manualByProduct.get(m.product_id) ?? 0) + Number(m.quantity ?? 0));

  const amzSalesByAsin = new Map<string, number>();
  for (const r of amzSales) amzSalesByAsin.set(r.asin, (amzSalesByAsin.get(r.asin) ?? 0) + Number(r.units_shipped ?? 0));
  const shopSalesByVariant = new Map<string, number>();
  for (const r of shopBurn) shopSalesByVariant.set(r.variant_id, (shopSalesByVariant.get(r.variant_id) ?? 0) + Number(r.units_sold ?? 0));
  const internalSalesByProduct = new Map<string, number>();
  for (const r of intSales) if (r.product_id) internalSalesByProduct.set(r.product_id, (internalSalesByProduct.get(r.product_id) ?? 0) + Number(r.units ?? 0));

  // ── build the five artifacts ──
  const journalEntry = buildJournalEntryLines({
    month, orders,
    internalRows: intSales.map((r) => ({
      product_id: r.product_id, gross_cents: r.gross_cents, order_total_cents: r.order_total_cents,
      tax_cents: r.tax_cents, discount_cents: r.discount_cents, shipping_cents: r.shipping_cents, line_index: r.line_index,
    })),
    processors, acct, gatewayLookup, shopifyMappingLookup, productLookup, shippingProtectionIds,
  } as JournalEntryInputs);

  const receiptItems: QbReceiptItem[] = items.map((i) => ({ id: i.id, quickbooks_id: String(i.quickbooks_id), item_type: i.item_type }));
  const receipts = {
    amazon: buildSalesReceiptLines(aggregateAmazonUnits(amzSales, mappings), receiptItems),
    shopify: buildSalesReceiptLines(aggregateShopifyUnits(shopBurn, mappings), receiptItems),
    internal: buildSalesReceiptLines(aggregateInternalUnits(intSales.map((r) => ({ product_id: r.product_id, units: r.units }))), receiptItems),
  };

  const auditProducts: AuditProduct[] = items
    .filter((i) => i.active !== false)
    .map((i) => ({
      id: i.id, quickbooks_id: String(i.quickbooks_id), name: i.quickbooks_name,
      sku: i.sku, item_type: i.item_type, product_category: i.product_category,
    }));
  const auditMappings: AuditMapping[] = mappings
    .filter((m) => m.active)
    .map((m) => ({ external_id: m.external_id, source: m.source, product_id: m.product_id, multiplier: m.unit_multiplier || 1 }));
  const auditBom: AuditBomRow[] = bom.map((b) => ({ parent_id: b.parent_id, component_id: b.component_id, quantity: Number(b.quantity) }));

  const audit = computeAuditVariances({
    products: auditProducts, mappings: auditMappings, bom: auditBom,
    qbInventory, fbaByAsin, tplBySku, manualByProduct,
    amzSalesByAsin, shopSalesByVariant, internalSalesByProduct, receivedByProduct,
  } as AuditInputs);
  const inventoryAdjustment = buildInventoryAdjustmentLines(audit);
  const auditRows = [...audit.bomComponents, ...audit.standalone];

  return {
    month, journalEntry, receipts, inventoryAdjustment, auditRows,
    meta: {
      priorMonth: prior, qbBasisRows: bookRows.length, fbaSnapshotDate: fbaDate, tplSnapshotDate: tplDate,
      shopifyOrderCount: orders.length, receivedItemCount: receivedByProduct.size,
    },
  };
}
