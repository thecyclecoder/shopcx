// PHASE 3 (historical). Reconcile the month-end InventoryAdjustment (shrinkage) for a
// frozen closed month vs the actual posted QBO adjustment — per-item whole-unit QtyDiff.
// Read-only, posts nothing. The `received` term (QB Bill/ItemReceipt/Purchase in-period)
// is passed in; pass --received-json=<file> to supply it, else it defaults to 0 (which
// isolates how much that term matters). Usage: _reconcile-inventory-adjustment.ts 2026-06
import * as fs from "fs";
import { computeAuditVariances, buildInventoryAdjustmentLines, type AuditInputs, type AuditProduct, type AuditMapping } from "../src/lib/qb-close/inventory-audit";

const MONTH = process.argv[2] || "2026-06";
const recArg = process.argv.find((a) => a.startsWith("--received-json="));
const DIR = "fixtures/shoptics-golden";
const load = (f: string) => JSON.parse(fs.readFileSync(`${DIR}/${f}.json`, "utf8"));
const [y, mo] = MONTH.split("-").map(Number);
const priorMonth = `${mo === 1 ? y - 1 : y}-${String(mo === 1 ? 12 : mo - 1).padStart(2, "0")}`;

const products: AuditProduct[] = load("products").filter((p: any) => p.active).map((p: any) => ({ id: p.id, quickbooks_id: String(p.quickbooks_id), name: p.quickbooks_name, sku: p.sku, item_type: p.item_type, product_category: p.product_category }));
const mappings: AuditMapping[] = load("sku_mappings").filter((m: any) => m.active).map((m: any) => ({ external_id: m.external_id, source: m.source, product_id: m.product_id, multiplier: m.unit_multiplier || 1 }));
const bom = load("product_bom").map((b: any) => ({ parent_id: b.parent_id, component_id: b.component_id, quantity: Number(b.quantity) }));

// QB start = prior-month month_end_post snapshot
const qbInventory = new Map<string, number>();
for (const s of load("inventory_snapshots")) { const p = s.raw_payload || {}; if (p.snapshot_type === "month_end_post" && p.month === priorMonth) qbInventory.set(s.product_id, s.quantity); }

const fbaByAsin = new Map<string, { fulfillable: number; transit: number }>();
for (const s of load("amazon_inventory_snapshots")) fbaByAsin.set(s.asin, { fulfillable: s.quantity_fulfillable, transit: s.quantity_transit || 0 });
const tplBySku = new Map<string, number>();
for (const s of load("tpl_inventory_snapshots")) tplBySku.set(s.sku, s.quantity_available);
const manualByProduct = new Map<string, number>();
for (const m of load("manual_inventory").filter((r: any) => r.active)) manualByProduct.set(m.product_id, (manualByProduct.get(m.product_id) || 0) + m.quantity);

const amzSalesByAsin = new Map<string, number>();
for (const r of load("amazon_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH)) amzSalesByAsin.set(r.asin, (amzSalesByAsin.get(r.asin) || 0) + r.units_shipped);
const shopSalesByVariant = new Map<string, number>();
for (const r of load("shopify_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH)) shopSalesByVariant.set(r.variant_id, (shopSalesByVariant.get(r.variant_id) || 0) + r.units_sold);
const internalSalesByProduct = new Map<string, number>();
for (const r of load("internal_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH)) { if (r.product_id) internalSalesByProduct.set(r.product_id, (internalSalesByProduct.get(r.product_id) || 0) + r.units); }

// received.json is keyed by quickbooks_id (QBO ItemRef); the audit keys `received` by
// product_id (UUID) — translate via the products fixture, mirroring the route's qbItemToProduct.
const qbIdToProduct = new Map<string, string>();
for (const p of load("products")) if (p.quickbooks_id) qbIdToProduct.set(String(p.quickbooks_id), p.id);
const receivedByProduct = new Map<string, number>();
if (recArg) { const rec = JSON.parse(fs.readFileSync(recArg.split("=")[1], "utf8")); for (const [qbId, v] of Object.entries(rec)) { const pid = qbIdToProduct.get(String(qbId)); if (pid) receivedByProduct.set(pid, (receivedByProduct.get(pid) || 0) + Number(v)); } }

const inp: AuditInputs = { products, mappings, bom, qbInventory, fbaByAsin, tplBySku, manualByProduct, amzSalesByAsin, shopSalesByVariant, internalSalesByProduct, receivedByProduct };
const shadowLines = buildInventoryAdjustmentLines(computeAuditVariances(inp));

// golden adjustment: QtyDiff by quickbooks item id
const jeFile = load(`qbo-entries/${MONTH}`);
const adjKey = Object.keys(jeFile).find((k) => k.startsWith("inventoryadjustment_"))!;
const adj = jeFile[adjKey].InventoryAdjustment ?? jeFile[adjKey];
const golden = new Map<string, number>();
for (const l of adj.Line || []) { const d = l.ItemAdjustmentLineDetail; if (d?.ItemRef?.value) golden.set(String(d.ItemRef.value), (golden.get(String(d.ItemRef.value)) || 0) + Number(d.QtyDiff || 0)); }
const shadow = new Map<string, number>();
for (const l of shadowLines) shadow.set(String(l.itemRef), (shadow.get(String(l.itemRef)) || 0) + l.qtyDiff);

console.log(`InventoryAdjustment historical reconcile — ${MONTH} (received term: ${recArg ? "supplied" : "ZERO (measuring)"})\n`);
console.log(`  shadow ${shadow.size} items / ${[...shadow.values()].reduce((a, b) => a + Math.abs(b), 0)} abs units · golden ${golden.size} items / ${[...golden.values()].reduce((a, b) => a + Math.abs(b), 0)} abs units\n`);
const keys = [...new Set([...shadow.keys(), ...golden.keys()])].sort();
let match = 0; const diffs: { k: string; s: number; g: number }[] = [];
for (const k of keys) { const s = shadow.get(k) ?? 0, g = golden.get(k) ?? 0; if (s === g) match++; else diffs.push({ k, s, g }); }
console.log(`  ${match}/${keys.length} items match. ${diffs.length} differ:`);
for (const d of diffs.slice(0, 40)) console.log(`    ✗ item ${d.k.padEnd(6)} shadow ${String(d.s).padStart(7)}  golden ${String(d.g).padStart(7)}  Δ ${d.s - d.g}`);
const totalAbsDelta = diffs.reduce((a, d) => a + Math.abs(d.s - d.g), 0);
console.log(diffs.length === 0 ? `\n✅ InventoryAdjustment reconciles exactly for ${MONTH}.` : `\n△ ${diffs.length} items differ · total abs Δ ${totalAbsDelta} units (see received-term/manual note).`);
process.exit(diffs.length === 0 ? 0 : 1);
