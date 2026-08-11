// DRY RUN of a full month-end close — runs every artifact builder in SHADOW (posts
// NOTHING) exactly as Shoptics' 8-step close would, then diffs all 5 produced QBO
// documents against what Shoptics ACTUALLY posted (fixtures/shoptics-golden/qbo-entries).
// Read-only: re-fetches the month's Shopify orders + QB receipts. The `received` term is
// reconstructed AS THE CLOSE SAW IT — excluding QB txns created after the close ran — so a
// frozen month reproduces to the unit. Usage: npx tsx scripts/_dry-run-close.ts 2026-06
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { qboFetch } from "../src/lib/quickbooks";
import * as fs from "fs";
import { buildJournalEntryLines, type JournalEntryInputs, type ProcessorTotals, type RevAcct } from "../src/lib/qb-close/journal-entry";
import { aggregateAmazonUnits, aggregateShopifyUnits, aggregateInternalUnits, buildSalesReceiptLines, type QbReceiptItem } from "../src/lib/qb-close/sales-receipt";
import { computeAuditVariances, buildInventoryAdjustmentLines, type AuditInputs, type AuditProduct, type AuditMapping } from "../src/lib/qb-close/inventory-audit";
import type { SkuMapping } from "../src/lib/qb-close/resolvers";

const MONTH = process.argv[2] || "2026-06";
const DIR = "fixtures/shoptics-golden";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const load = (f: string) => JSON.parse(fs.readFileSync(`${DIR}/${f}.json`, "utf8"));
const [Y, MO] = MONTH.split("-").map(Number);
const lastDay = new Date(Y, MO, 0).getDate();
const priorMonth = `${MO === 1 ? Y - 1 : Y}-${String(MO === 1 ? 12 : MO - 1).padStart(2, "0")}`;
const inMonth = (r: any) => String(r.sale_date).slice(0, 7) === MONTH;
const C = { g: (s: any) => `\x1b[32m${s}\x1b[0m`, r: (s: any) => `\x1b[31m${s}\x1b[0m`, b: (s: any) => `\x1b[1m${s}\x1b[0m`, d: (s: any) => `\x1b[2m${s}\x1b[0m` };

const closing = load("month_end_closings").find((x: any) => x.closing_month === MONTH);
const closeRanAt = new Date(closing?.completed_at ?? `${MONTH}-${lastDay}T23:59:59Z`).getTime();

async function fetchShopifyOrders() {
  const admin = createAdminClient();
  const { data: tok } = await createAdminClient().from("shopify_tokens" as any).select("*"); void tok; void admin;
  // Shopify token lives in the SHOPTICS db (same shop) — read it there, read-only.
  const { createClient } = await import("@supabase/supabase-js");
  const envText = fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8"); const env: Record<string, string> = {};
  for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  const sh = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: t } = await sh.from("shopify_tokens").select("shop_domain, access_token").limit(1);
  const tk = t?.[0]; if (!tk) throw new Error("Shopify not connected");
  let url: string | null = `https://${tk.shop_domain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${MONTH}-01T00:00:00Z&created_at_max=${MONTH}-${String(lastDay).padStart(2, "0")}T23:59:59Z&fields=id,line_items,total_shipping_price_set,total_tax,total_discounts,subtotal_price,total_price,payment_gateway_names,financial_status`;
  let all: any[] = [];
  while (url) { const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": tk.access_token } }); if (!res.ok) throw new Error(`Shopify ${res.status}`); const d = await res.json(); all = all.concat((d.orders || []).filter((o: any) => ["paid", "partially_refunded", "refunded"].includes(o.financial_status))); const lh = res.headers.get("link") || ""; const nm = lh.match(/<([^>]+)>;\s*rel="next"/); url = nm ? nm[1] : null; }
  return all;
}

async function fetchReceivedAsOfClose() {
  const admin = createAdminClient();
  const start = `${MONTH}-01`, end = `${MONTH}-${String(lastDay).padStart(2, "0")}`;
  const received = new Map<string, number>(); let excluded = 0;
  for (const entity of ["Bill", "Purchase"]) { // ItemReceipt isn't a queryable QBO entity (Shoptics try/catches it too)
    let data: any; try { data = await qboFetch(WS, "query", { query: { query: `SELECT * FROM ${entity} WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' MAXRESULTS 1000` }, admin }); } catch { continue; }
    for (const txn of data.QueryResponse?.[entity] || []) {
      const created = new Date(txn.MetaData?.CreateTime ?? 0).getTime();
      if (created > closeRanAt) { for (const line of txn.Line || []) { const d = line.ItemBasedExpenseLineDetail; if (d?.ItemRef?.value && d.Qty) excluded++; } continue; } // created after the close ran → the close never saw it
      for (const line of txn.Line || []) { const d = line.ItemBasedExpenseLineDetail; if (!d?.ItemRef?.value || d.Qty === undefined) continue; const q = Number(d.Qty) || 0; if (q === 0) continue; received.set(String(d.ItemRef.value), (received.get(String(d.ItemRef.value)) || 0) + q); }
    }
  }
  return { received, excluded };
}

function aggCents(ls: { amount: number; posting: string; accountId: string }[]) { const m = new Map<string, number>(); for (const l of ls) { const k = `${l.posting}:${l.accountId}`; m.set(k, (m.get(k) ?? 0) + Math.round(l.amount * 100)); } return m; }
function qtyByItem(sr: any) { const m = new Map<string, number>(); for (const l of sr.Line || []) { const gd = l.GroupLineDetail, sd = l.SalesItemLineDetail; if (gd) m.set(String(gd.GroupItemRef.value), (m.get(String(gd.GroupItemRef.value)) ?? 0) + Number(gd.Quantity || 0)); else if (sd) m.set(String(sd.ItemRef.value), (m.get(String(sd.ItemRef.value)) ?? 0) + Number(sd.Qty || 0)); } return m; }

async function main() {
  console.log(C.b(`\n═══ DRY RUN — Month-End Close ${MONTH} (SHADOW · posts nothing) ═══\n`));
  console.log(C.d(`  golden close ran ${closing?.completed_at} · status ${closing?.status}\n`));

  // shared lookups
  const acct: Record<string, { value: string; name: string }> = {}; for (const r of load("qb_account_mappings")) acct[r.key] = { value: String(r.qb_id), name: r.qb_name };
  const productLookup = new Map<string, RevAcct>(); for (const p of load("products")) productLookup.set(p.id, { name: p.quickbooks_name, rev_acct_id: p.revenue_account_id, rev_acct_name: p.revenue_account_name });
  const gatewayLookup = new Map<string, string>(); for (const g of load("gateway_mappings")) gatewayLookup.set(g.gateway_name, g.processor);
  const skuMappings: SkuMapping[] = load("sku_mappings").map((m: any) => ({ external_id: m.external_id, source: m.source, product_id: m.product_id, unit_multiplier: m.unit_multiplier, active: m.active }));
  const shopifyMappingLookup = new Map<string, string>(); for (const m of skuMappings) if (m.source === "shopify" && m.active) shopifyMappingLookup.set(m.external_id, m.product_id);
  const shippingProtectionIds = new Set<string>(load("shipping_protection_products").map((r: any) => String(r.shopify_product_id)));
  const processors: Record<string, ProcessorTotals> = {}; for (const p of load("payment_processor_summaries").filter((x: any) => x.closing_month === MONTH)) processors[p.processor] = { gross: +p.gross_sales, fees: +p.processing_fees, refunds: +p.refunds, chargebacks: +p.chargebacks, adjustments: +p.adjustments };
  const internalSalesRows = load("internal_sales_snapshots").filter(inMonth);
  const golden = load(`qbo-entries/${MONTH}`);

  const results: { step: string; ok: boolean; detail: string }[] = [];

  // ── Live reads (steps 1/6 snapshots + the received term + Shopify orders) ──
  process.stdout.write(C.d("  fetching live Shopify orders + QB receipts (read-only)… "));
  const [orders, rec] = await Promise.all([fetchShopifyOrders(), fetchReceivedAsOfClose()]);
  console.log(C.d(`${orders.length} orders · ${rec.received.size} received-items (${rec.excluded} post-close line(s) excluded)\n`));

  // ── STEP 8: JournalEntry ──
  const je = buildJournalEntryLines({ month: MONTH, orders, internalRows: internalSalesRows.map((r: any) => ({ product_id: r.product_id, gross_cents: r.gross_cents, order_total_cents: r.order_total_cents, tax_cents: r.tax_cents, discount_cents: r.discount_cents, shipping_cents: r.shipping_cents, line_index: r.line_index })), processors, acct, gatewayLookup, shopifyMappingLookup, productLookup, shippingProtectionIds } as JournalEntryInputs);
  const gJeKey = Object.keys(golden).find((k) => k.startsWith("journalentry_"))!; const gJe = golden[gJeKey].JournalEntry ?? golden[gJeKey];
  const sJe = aggCents(je.lines), gJeAgg = aggCents((gJe.Line || []).filter((l: any) => l.JournalEntryLineDetail).map((l: any) => ({ amount: l.Amount, posting: l.JournalEntryLineDetail.PostingType, accountId: l.JournalEntryLineDetail.AccountRef.value })));
  let jeDiffs = 0; for (const k of new Set([...sJe.keys(), ...gJeAgg.keys()])) if ((sJe.get(k) ?? 0) !== (gJeAgg.get(k) ?? 0)) jeDiffs++;
  results.push({ step: "JournalEntry", ok: jeDiffs === 0 && Math.abs(je.totalDebits - je.totalCredits) < 0.005, detail: `${je.lines.length} lines · $${je.totalDebits.toFixed(2)} balanced · ${jeDiffs === 0 ? "all lines match" : jeDiffs + " differ"}` });

  // ── STEPS 3/4/5: SalesReceipts ──
  const items: QbReceiptItem[] = load("products").map((p: any) => ({ id: p.id, quickbooks_id: String(p.quickbooks_id), item_type: p.item_type }));
  const chan = {
    amazon: buildSalesReceiptLines(aggregateAmazonUnits(load("amazon_sales_snapshots").filter(inMonth).map((r: any) => ({ asin: r.asin, units_shipped: r.units_shipped })), skuMappings), items),
    shopify: buildSalesReceiptLines(aggregateShopifyUnits(load("shopify_sales_snapshots").filter(inMonth).map((r: any) => ({ variant_id: r.variant_id, units_sold: r.units_sold })), skuMappings), items),
    internal: buildSalesReceiptLines(aggregateInternalUnits(internalSalesRows.map((r: any) => ({ product_id: r.product_id, units: r.units }))), items),
  };
  const CUST: Record<string, string> = { "40": "amazon", "30410": "shopify" };
  const gReceipts: Record<string, Map<string, number>> = {};
  for (const k of Object.keys(golden).filter((x) => x.startsWith("salesreceipt_"))) { const sr = golden[k].SalesReceipt ?? golden[k]; gReceipts[CUST[String(sr.CustomerRef?.value)] ?? "internal"] = qtyByItem(sr); }
  for (const ch of ["amazon", "shopify", "internal"] as const) {
    const shadow = new Map<string, number>(); for (const l of (chan as any)[ch]) shadow.set(String(l.itemRef), (shadow.get(String(l.itemRef)) ?? 0) + l.qty);
    const g = gReceipts[ch] ?? new Map(); let d = 0; for (const k of new Set([...shadow.keys(), ...g.keys()])) if ((shadow.get(k) ?? 0) !== (g.get(k) ?? 0)) d++;
    const units = [...shadow.values()].reduce((a, b) => a + b, 0);
    results.push({ step: `SalesReceipt · ${ch}`, ok: d === 0, detail: `${(chan as any)[ch].length} lines / ${units} units · ${d === 0 ? "quantities match" : d + " differ"}` });
  }

  // ── STEP 2: InventoryAdjustment ──
  const products: AuditProduct[] = load("products").filter((p: any) => p.active).map((p: any) => ({ id: p.id, quickbooks_id: String(p.quickbooks_id), name: p.quickbooks_name, sku: p.sku, item_type: p.item_type, product_category: p.product_category }));
  const auditMappings: AuditMapping[] = skuMappings.filter((m) => m.active).map((m) => ({ external_id: m.external_id, source: m.source, product_id: m.product_id, multiplier: m.unit_multiplier || 1 }));
  const qbInventory = new Map<string, number>(); for (const s of load("inventory_snapshots")) { const p = s.raw_payload || {}; if (p.snapshot_type === "month_end_post" && p.month === priorMonth) qbInventory.set(s.product_id, s.quantity); }
  const fbaByAsin = new Map<string, { fulfillable: number; transit: number }>(); for (const s of load("amazon_inventory_snapshots")) fbaByAsin.set(s.asin, { fulfillable: s.quantity_fulfillable, transit: s.quantity_transit || 0 });
  const tplBySku = new Map<string, number>(); for (const s of load("tpl_inventory_snapshots")) tplBySku.set(s.sku, s.quantity_available);
  const manualByProduct = new Map<string, number>(); for (const m of load("manual_inventory").filter((r: any) => r.active)) manualByProduct.set(m.product_id, (manualByProduct.get(m.product_id) || 0) + m.quantity);
  const amzSalesByAsin = new Map<string, number>(); for (const r of load("amazon_sales_snapshots").filter(inMonth)) amzSalesByAsin.set(r.asin, (amzSalesByAsin.get(r.asin) || 0) + r.units_shipped);
  const shopSalesByVariant = new Map<string, number>(); for (const r of load("shopify_sales_snapshots").filter(inMonth)) shopSalesByVariant.set(r.variant_id, (shopSalesByVariant.get(r.variant_id) || 0) + r.units_sold);
  const internalSalesByProduct = new Map<string, number>(); for (const r of internalSalesRows) if (r.product_id) internalSalesByProduct.set(r.product_id, (internalSalesByProduct.get(r.product_id) || 0) + r.units);
  const qbIdToProduct = new Map<string, string>(); for (const p of load("products")) if (p.quickbooks_id) qbIdToProduct.set(String(p.quickbooks_id), p.id);
  const receivedByProduct = new Map<string, number>(); for (const [qbId, v] of rec.received) { const pid = qbIdToProduct.get(String(qbId)); if (pid) receivedByProduct.set(pid, (receivedByProduct.get(pid) || 0) + v); }
  const adjLines = buildInventoryAdjustmentLines(computeAuditVariances({ products, mappings: auditMappings, bom: load("product_bom").map((b: any) => ({ parent_id: b.parent_id, component_id: b.component_id, quantity: Number(b.quantity) })), qbInventory, fbaByAsin, tplBySku, manualByProduct, amzSalesByAsin, shopSalesByVariant, internalSalesByProduct, receivedByProduct } as AuditInputs));
  const gAdjKey = Object.keys(golden).find((k) => k.startsWith("inventoryadjustment_"))!; const gAdj = golden[gAdjKey].InventoryAdjustment ?? golden[gAdjKey];
  const gAdjQty = new Map<string, number>(); for (const l of gAdj.Line || []) { const d = l.ItemAdjustmentLineDetail; if (d?.ItemRef?.value) gAdjQty.set(String(d.ItemRef.value), (gAdjQty.get(String(d.ItemRef.value)) ?? 0) + Number(d.QtyDiff || 0)); }
  const sAdjQty = new Map<string, number>(); for (const l of adjLines) sAdjQty.set(String(l.itemRef), (sAdjQty.get(String(l.itemRef)) ?? 0) + l.qtyDiff);
  let adjDiffs = 0; for (const k of new Set([...sAdjQty.keys(), ...gAdjQty.keys()])) if ((sAdjQty.get(k) ?? 0) !== (gAdjQty.get(k) ?? 0)) adjDiffs++;
  results.push({ step: "InventoryAdjustment", ok: adjDiffs === 0, detail: `${adjLines.length} lines / ${[...sAdjQty.values()].reduce((a, b) => a + Math.abs(b), 0)} abs units · ${adjDiffs === 0 ? "all items match" : adjDiffs + " differ"}` });

  // ── Report ──
  console.log(C.b("  Artifact                     vs Shoptics' actual QBO posting"));
  console.log(C.d("  ────────────────────────────────────────────────────────────────"));
  for (const r of results) console.log(`  ${r.ok ? C.g("✓") : C.r("✗")} ${r.step.padEnd(26)} ${r.ok ? C.g("MATCH") : C.r("DIFF ")}  ${C.d(r.detail)}`);
  const allOk = results.every((r) => r.ok);
  console.log("\n" + (allOk ? C.g(C.b(`  ✅ DRY RUN RECONCILES — all 5 QBO artifacts reproduce Shoptics' June close exactly.`)) : C.r(C.b(`  ✗ ${results.filter((r) => !r.ok).length} artifact(s) differ.`))));
  console.log(C.d(`\n  (Shadow only — no QuickBooks entries were created.)\n`));
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
