// PHASE 3 (historical). Reconcile the 3 zero-dollar SalesReceipts (Amazon/Shopify/Internal)
// for a frozen closed month vs actual posted QBO — per-item quantities to the unit.
// Read-only, posts nothing. Usage: npx tsx scripts/_reconcile-receipts.ts 2026-06
import * as fs from "fs";
import { aggregateAmazonUnits, aggregateShopifyUnits, aggregateInternalUnits, buildSalesReceiptLines, type QbReceiptItem } from "../src/lib/qb-close/sales-receipt";
import type { SkuMapping } from "../src/lib/qb-close/resolvers";

const MONTH = process.argv[2] || "2026-06";
const DIR = "fixtures/shoptics-golden";
const load = (f: string) => JSON.parse(fs.readFileSync(`${DIR}/${f}.json`, "utf8"));

const mappings: SkuMapping[] = load("sku_mappings").map((m: any) => ({ external_id: m.external_id, source: m.source, product_id: m.product_id, unit_multiplier: m.unit_multiplier, active: m.active }));
const items: QbReceiptItem[] = load("products").map((p: any) => ({ id: p.id, quickbooks_id: p.quickbooks_id, item_type: p.item_type }));
const amazonRows = load("amazon_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH).map((r: any) => ({ asin: r.asin, units_shipped: r.units_shipped }));
const shopifyRows = load("shopify_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH).map((r: any) => ({ variant_id: r.variant_id, units_sold: r.units_sold }));
const internalRows = load("internal_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH).map((r: any) => ({ product_id: r.product_id, units: r.units }));

const channels = {
  amazon: buildSalesReceiptLines(aggregateAmazonUnits(amazonRows, mappings), items),
  shopify: buildSalesReceiptLines(aggregateShopifyUnits(shopifyRows, mappings), items),
  internal: buildSalesReceiptLines(aggregateInternalUnits(internalRows), items),
};

// golden receipts: qty by quickbooks_id (GroupItemRef or ItemRef). CustomerRef distinguishes channel.
const jeFile = load(`qbo-entries/${MONTH}`);
const receipts = Object.keys(jeFile).filter((k) => k.startsWith("salesreceipt_")).map((k) => jeFile[k].SalesReceipt ?? jeFile[k]);
const CUST: Record<string, string> = { "40": "amazon", "30410": "shopify" }; // internal = the remaining one
function goldenQtyByItem(r: any): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of r.Line || []) {
    const gd = l.GroupLineDetail, sd = l.SalesItemLineDetail;
    if (gd) m.set(gd.GroupItemRef.value, (m.get(gd.GroupItemRef.value) ?? 0) + Number(gd.Quantity || 0));
    else if (sd) m.set(sd.ItemRef.value, (m.get(sd.ItemRef.value) ?? 0) + Number(sd.Qty || 0));
  }
  return m;
}
const goldenByChannel: Record<string, Map<string, number>> = {};
for (const r of receipts) { const cust = String(r.CustomerRef?.value ?? ""); const ch = CUST[cust] ?? "internal"; goldenByChannel[ch] = goldenQtyByItem(r); }

console.log(`Sales-receipt historical reconcile — ${MONTH} (read-only, posts nothing)\n`);
let allOk = true;
for (const ch of ["amazon", "shopify", "internal"] as const) {
  const shadow = new Map<string, number>();
  for (const l of channels[ch]) shadow.set(l.itemRef, (shadow.get(l.itemRef) ?? 0) + l.qty);
  const golden = goldenByChannel[ch] ?? new Map();
  const keys = new Set([...shadow.keys(), ...golden.keys()]);
  const diffs: string[] = [];
  for (const k of keys) { const s = shadow.get(k) ?? 0, g = golden.get(k) ?? 0; if (s !== g) diffs.push(`item ${k}: shadow ${s} vs golden ${g}`); }
  const shadowUnits = [...shadow.values()].reduce((a, b) => a + b, 0), goldenUnits = [...golden.values()].reduce((a, b) => a + b, 0);
  const ok = diffs.length === 0; allOk = allOk && ok;
  console.log(`  ${ch.padEnd(9)} ${channels[ch].length} lines / ${shadowUnits} units — ${ok ? `✓ matches golden (${golden.size} items, ${goldenUnits} units)` : `✗ ${diffs.length} diff(s): ${diffs.slice(0, 5).join("; ")}`}`);
}
console.log(allOk ? `\n✅ All 3 SalesReceipts reconcile exactly (per-item quantities) vs actual posted QBO for ${MONTH}.` : `\n✗ receipt variance found.`);
process.exit(allOk ? 0 : 1);
