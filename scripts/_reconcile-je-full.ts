// PHASE 3 (historical re-run). Reconcile the FULL shadow month-end JournalEntry for a
// frozen, already-closed month against what Shoptics actually posted to QBO — to the penny.
// Read-only: re-fetches that month's Shopify orders (historical, immutable) + reads the
// golden fixtures. POSTS NOTHING. Usage: npx tsx scripts/_reconcile-je-full.ts 2026-06
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { buildJournalEntryLines, type JournalEntryInputs, type ProcessorTotals, type RevAcct } from "../src/lib/qb-close/journal-entry";

const MONTH = process.argv[2] || "2026-06";
const DIR = "fixtures/shoptics-golden";
const load = (f: string) => JSON.parse(fs.readFileSync(`${DIR}/${f}.json`, "utf8"));
const envText = fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8");
const env: Record<string, string> = {};
for (const l of envText.split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const sh = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function fetchShopifyOrders(month: string) {
  const { data: tok } = await sh.from("shopify_tokens").select("shop_domain, access_token").limit(1);
  const t = tok?.[0]; if (!t) throw new Error("Shopify not connected");
  const [y, mo] = month.split("-").map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  const start = `${month}-01T00:00:00Z`, end = `${month}-${String(lastDay).padStart(2, "0")}T23:59:59Z`;
  let url: string | null = `https://${t.shop_domain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min=${start}&created_at_max=${end}&fields=id,line_items,total_shipping_price_set,total_tax,total_discounts,subtotal_price,total_price,payment_gateway_names,financial_status`;
  let all: any[] = [];
  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": t.access_token } });
    if (!res.ok) throw new Error(`Shopify Orders API ${res.status}`);
    const data = await res.json();
    all = all.concat((data.orders || []).filter((o: any) => ["paid", "partially_refunded", "refunded"].includes(o.financial_status)));
    const lh = res.headers.get("link") || ""; const nm = lh.match(/<([^>]+)>;\s*rel="next"/); url = nm ? nm[1] : null;
  }
  return all;
}

async function main() {
  console.log(`Full JournalEntry historical reconcile — ${MONTH} (read-only, posts nothing)\n`);

  // account map (semantic keys) + revenue-account lookup (per product)
  const acct: Record<string, { value: string; name: string }> = {};
  for (const r of load("qb_account_mappings")) acct[r.key] = { value: String(r.qb_id), name: r.qb_name };
  const productLookup = new Map<string, RevAcct>();
  for (const p of load("products")) productLookup.set(p.id, { name: p.quickbooks_name, rev_acct_id: p.revenue_account_id, rev_acct_name: p.revenue_account_name });
  const gatewayLookup = new Map<string, string>();
  for (const g of load("gateway_mappings")) gatewayLookup.set(g.gateway_name, g.processor);
  const shopifyMappingLookup = new Map<string, string>();
  for (const m of load("sku_mappings")) if (m.source === "shopify" && m.active) shopifyMappingLookup.set(m.external_id, m.product_id);
  const shippingProtectionIds = new Set<string>(load("shipping_protection_products").map((r: any) => String(r.shopify_product_id)));
  const processors: Record<string, ProcessorTotals> = {};
  for (const p of load("payment_processor_summaries").filter((x: any) => x.closing_month === MONTH))
    processors[p.processor] = { gross: +p.gross_sales, fees: +p.processing_fees, refunds: +p.refunds, chargebacks: +p.chargebacks, adjustments: +p.adjustments };
  const internalRows = load("internal_sales_snapshots").filter((r: any) => String(r.sale_date).slice(0, 7) === MONTH)
    .map((r: any) => ({ product_id: r.product_id, gross_cents: r.gross_cents, order_total_cents: r.order_total_cents, tax_cents: r.tax_cents, discount_cents: r.discount_cents, shipping_cents: r.shipping_cents, line_index: r.line_index }));

  const orders = await fetchShopifyOrders(MONTH);
  console.log(`  fetched ${orders.length} Shopify orders (paid/partial/refunded), ${internalRows.length} internal snapshot rows\n`);

  const inp: JournalEntryInputs = { month: MONTH, orders, internalRows, processors, acct, gatewayLookup, shopifyMappingLookup, productLookup, shippingProtectionIds };
  const { lines, totalDebits, totalCredits, warnings } = buildJournalEntryLines(inp);
  console.log(`  shadow JE: ${lines.length} lines · debits ${totalDebits.toFixed(2)} · credits ${totalCredits.toFixed(2)} · balanced=${(Math.abs(totalDebits - totalCredits) < 0.005)}`);
  if (warnings.length) console.log("  warnings:", warnings.join(" | "));

  // golden JE
  const jeFile = load(`qbo-entries/${MONTH}`);
  const jeKey = Object.keys(jeFile).find((k) => k.startsWith("journalentry_"))!;
  const je = jeFile[jeKey].JournalEntry ?? jeFile[jeKey];
  const agg = (ls: { amount: number; posting: string; accountId: string }[]) => { const map = new Map<string, number>(); for (const l of ls) { const k = `${l.posting}:${l.accountId}`; map.set(k, (map.get(k) ?? 0) + Math.round(l.amount * 100)); } return map; };
  const goldenLines = (je.Line || []).filter((l: any) => l.JournalEntryLineDetail).map((l: any) => ({ amount: l.Amount, posting: l.JournalEntryLineDetail.PostingType, accountId: l.JournalEntryLineDetail.AccountRef.value }));
  const sAgg = agg(lines), gAgg = agg(goldenLines);

  const keys = [...new Set([...sAgg.keys(), ...gAgg.keys()])].sort();
  const diffs: string[] = [];
  console.log("\n  per (posting:account) — shadow vs golden:");
  for (const k of keys) { const s = sAgg.get(k) ?? 0, g = gAgg.get(k) ?? 0; const ok = s === g; if (!ok) diffs.push(k); console.log(`    ${ok ? "✓" : "✗"} ${k.padEnd(14)} shadow ${(s / 100).toFixed(2).padStart(12)}  golden ${(g / 100).toFixed(2).padStart(12)}${ok ? "" : `   Δ ${((s - g) / 100).toFixed(2)}`}`); }
  const totalDelta = ([...keys].reduce((a, k) => a + Math.abs((sAgg.get(k) ?? 0) - (gAgg.get(k) ?? 0)), 0) / 100);
  console.log(diffs.length === 0
    ? `\n✅ FULL JournalEntry reconciles to $0.00 vs actual posted QBO for ${MONTH}.`
    : `\n✗ ${diffs.length} line(s) differ · total abs variance $${totalDelta.toFixed(2)}`);
  process.exit(diffs.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
