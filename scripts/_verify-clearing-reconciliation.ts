/**
 * Cross-check the JE's CLEARING accounts against the processors' own gross.
 *
 * A processor's clearing DEBIT is order gross by gateway, and for Braintree and PayPal that gross
 * comes from a COMBINATION of sources: Shopify orders carrying that gateway PLUS ShopCX-native
 * internal orders (which settle through Braintree). The matching processor rollup, by contrast,
 * sees every transaction that processor handled regardless of origin.
 *
 * So for each processor:
 *
 *   clearing debit  =  Σ Shopify order gross on that gateway  +  Σ internal order gross (Braintree)
 *   processor gross =  what the processor itself reports settling in the period
 *
 * These should be close. A persistent gap means orders are being attributed to the wrong
 * processor, or a source is missing from the clearing debit entirely — which would quietly
 * misstate the clearing balance while the JE still balances, because both sides move together.
 *
 * Read-only. Usage: npx tsx scripts/_verify-clearing-reconciliation.ts 2026-07
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildMonthEndArtifacts } from "../src/lib/qb-close/month-end";
import type { ShopifyOrder } from "../src/lib/qb-close/journal-entry";
import { annotateGatewayAmounts } from "../src/lib/qb-close/gateway-amounts";
import * as fs from "fs";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MONTH = process.argv[2] || "2026-07";
const [Y, MO] = MONTH.split("-").map(Number);
const LAST = String(new Date(Y, MO, 0).getDate()).padStart(2, "0");

async function fetchShopifyOrders(): Promise<ShopifyOrder[]> {
  const env: Record<string, string> = {};
  for (const l of fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const tk = (
    await (
      await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/shopify_tokens?select=shop_domain,access_token&id=eq.current`, {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      })
    ).json()
  )[0];
  let url: string | null =
    `https://${tk.shop_domain}/admin/api/2024-01/orders.json?status=any&limit=250` +
    `&created_at_min=${MONTH}-01T00:00:00Z&created_at_max=${MONTH}-${LAST}T23:59:59Z` +
    `&fields=id,line_items,total_shipping_price_set,total_tax,total_discounts,subtotal_price,total_price,payment_gateway_names,financial_status`;
  const all: ShopifyOrder[] = [];
  while (url) {
    const r: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": tk.access_token } });
    const d = await r.json();
    all.push(...(d.orders ?? []).filter((o: { financial_status: string }) => ["paid", "partially_refunded", "refunded"].includes(o.financial_status)));
    const m = (r.headers.get("link") ?? "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  // Must annotate here too, or this check measures the equal-split fallback rather than what the
  // close actually builds.
  const split = await annotateGatewayAmounts(all as (ShopifyOrder & { id?: number | string })[], tk.shop_domain, tk.access_token);
  console.log(`  split-payment orders resolved: ${split.resolved} (${split.failed} fell back) · reallocated $${split.correction.toFixed(2)}`);
  return all;
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const admin = createAdminClient();
  const orders = await fetchShopifyOrders();
  const art = await buildMonthEndArtifacts({ workspaceId: WS, month: MONTH, admin, orders });

  const summary = (art as unknown as { journalEntry: { lines: unknown[] } }) && art.journalEntry;
  void summary;

  // Clearing debits straight off the built JE, by account name.
  const clearingDebits = new Map<string, number>();
  for (const l of art.journalEntry.lines) {
    if (l.posting !== "Debit" || !/^Clearing:/i.test(l.accountName)) continue;
    clearingDebits.set(l.accountName, (clearingDebits.get(l.accountName) ?? 0) + l.amount);
  }

  const { data: procs } = await admin
    .from("qb_payment_processor_summaries")
    .select("processor, gross_sales, processing_fees, refunds, chargebacks")
    .eq("workspace_id", WS).eq("closing_month", MONTH);

  const NAME: Record<string, string> = {
    shopify_payments: "Clearing:Shopify",
    paypal: "Clearing:PayPal",
    braintree: "Clearing:Braintree",
  };

  console.log(`\nCLEARING RECONCILIATION — ${MONTH}\n`);
  console.log(
    `  ⭐ These are TWO DIFFERENT ACCOUNTING BASES and are not expected to be equal.\n` +
      `     The books are ACCRUAL: the JE's clearing debit is ORDER-dated — revenue belongs to the\n` +
      `     month the order was placed. A processor's gross is PAYOUT/SETTLEMENT-dated — cash. At a\n` +
      `     month boundary the two differ by the tail: measured for 2026-07, July's Shopify payouts\n` +
      `     carried $11,813.21 of JUNE charges while ~$11,214.74 of July charges paid out in August,\n` +
      `     netting the $598.47 delta. That is CORRECT, not a defect.\n` +
      `     Braintree ties exactly only because it settles same/next-day, so its window nearly\n` +
      `     coincides with the order window — a narrower boundary, not a better reconciliation.\n` +
      `     Investigate a delta that is LARGE relative to a boundary day's charges, or one that is\n` +
      `     the size of a known refund/chargeback total. A few tenths of a percent is the tail.\n` +
      `  ⚠ 'processor gross' is whatever is STORED. A row written by a mid-month snapshot understates\n` +
      `     the month and makes every delta read high — check synced_at, and re-run\n` +
      `     scripts/_verify-processor-sync.ts for the fresh figure.\n`,
  );
  console.log(`${"processor".padEnd(18)}${"JE clearing debit".padStart(20)}${"processor gross".padStart(18)}${"delta".padStart(14)}`);
  for (const p of procs ?? []) {
    const acct = NAME[String(p.processor)];
    if (!acct) continue;
    const debit = clearingDebits.get(acct) ?? 0;
    const gross = Number(p.gross_sales);
    const delta = Math.round((debit - gross) * 100) / 100;
    const pct = gross ? (delta / gross) * 100 : 0;
    console.log(
      String(p.processor).padEnd(18) + money(debit).padStart(20) + money(gross).padStart(18) +
        `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`.padStart(14),
    );
  }

  // Where the Braintree clearing debit comes from — the combination Dylan flagged.
  const internal = art.journalEntry.lines.find((l) => /Internal deposits/i.test(l.description));
  const shopifySideBraintree = (clearingDebits.get("Clearing:Braintree") ?? 0) - (internal?.amount ?? 0);
  console.log(`\nClearing:Braintree is a COMBINATION:`);
  console.log(`   Shopify orders on a Braintree gateway   ${money(shopifySideBraintree)}`);
  console.log(`   ShopCX internal orders (Braintree)      ${money(internal?.amount ?? 0)}`);
  console.log(`   total clearing debit                    ${money(clearingDebits.get("Clearing:Braintree") ?? 0)}`);
  console.log(`\nAll clearing accounts on the JE:`);
  for (const [k, v] of [...clearingDebits.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(36)} ${money(v)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
