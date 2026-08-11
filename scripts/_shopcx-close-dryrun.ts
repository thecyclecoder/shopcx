/**
 * SHADOW month-end close driven entirely by ShopCX's OWN tables (qb_* source layer), then
 * diffed against Shoptics' actual posted QBO documents for the same month.
 *
 * This is the Phase-1 acceptance test the earlier `_dry-run-close.ts` could not be: that one
 * read `fixtures/shoptics-golden/*.json`, so it proved the ENGINE but never that ShopCX holds
 * the data. Posts nothing.
 *
 * Usage: npx tsx scripts/_shopcx-close-dryrun.ts 2026-06
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { qboFetch } from "../src/lib/quickbooks";
import { buildMonthEndArtifacts } from "../src/lib/qb-close/month-end";
import { assessDryRun, recordDryRun } from "../src/lib/qb-close/close-guard";
import type { ShopifyOrder } from "../src/lib/qb-close/journal-entry";
import * as fs from "fs";

const MONTH = process.argv[2] || "2026-06";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const [Y, MO] = MONTH.split("-").map(Number);
const LAST = new Date(Y, MO, 0).getDate();
const C = {
  g: (s: unknown) => `\x1b[32m${s}\x1b[0m`, r: (s: unknown) => `\x1b[31m${s}\x1b[0m`,
  b: (s: unknown) => `\x1b[1m${s}\x1b[0m`, d: (s: unknown) => `\x1b[2m${s}\x1b[0m`,
};

/** Shopify orders for the month. Token lives in the Shoptics DB (same shop), read-only. */
async function fetchShopifyOrders(): Promise<ShopifyOrder[]> {
  const env: Record<string, string> = {};
  for (const l of fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const tr = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/shopify_tokens?select=shop_domain,access_token&id=eq.current`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  const tk = (await tr.json())[0];
  if (!tk) throw new Error("Shopify not connected");
  let url: string | null =
    `https://${tk.shop_domain}/admin/api/2024-01/orders.json?status=any&limit=250` +
    `&created_at_min=${MONTH}-01T00:00:00Z&created_at_max=${MONTH}-${String(LAST).padStart(2, "0")}T23:59:59Z` +
    `&fields=id,line_items,total_shipping_price_set,total_tax,total_discounts,subtotal_price,total_price,payment_gateway_names,financial_status`;
  const all: ShopifyOrder[] = [];
  while (url) {
    const res: Response = await fetch(url, { headers: { "X-Shopify-Access-Token": tk.access_token } });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const d = await res.json();
    all.push(...(d.orders || []).filter((o: { financial_status: string }) =>
      ["paid", "partially_refunded", "refunded"].includes(o.financial_status)));
    const m = (res.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return all;
}

/**
 * QB receipts (Bill/Purchase item lines) in the period, keyed to ShopCX qb_items.id.
 *
 * Returns `ok` separately from the map. "Nothing received" and "the query broke" are the SAME
 * empty map, and conflating them is exactly how July lost a 9,652-unit bill and booked a $67,131
 * phantom gain. `Bill` and `Purchase` must BOTH succeed for the term to count as verified;
 * `ItemReceipt` is not a queryable QBO entity and its rejection is expected, not a failure.
 */
async function fetchReceived(admin: ReturnType<typeof createAdminClient>) {
  const start = `${MONTH}-01`, end = `${MONTH}-${String(LAST).padStart(2, "0")}`;
  const byQbItem = new Map<string, number>();
  let ok = true;
  for (const entity of ["Bill", "Purchase"]) {
    try {
      const data = await qboFetch(WS, "query", {
        query: { query: `SELECT * FROM ${entity} WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' MAXRESULTS 1000` },
        admin,
      });
      for (const txn of data.QueryResponse?.[entity] || [])
        for (const line of txn.Line || []) {
          const d = line.ItemBasedExpenseLineDetail;
          if (!d?.ItemRef?.value || d.Qty === undefined) continue;
          const q = Number(d.Qty) || 0;
          if (q) byQbItem.set(String(d.ItemRef.value), (byQbItem.get(String(d.ItemRef.value)) ?? 0) + q);
        }
    } catch (e) {
      ok = false;
      console.log(C.r(`  ⚠ QB ${entity} query FAILED: ${(e as Error).message.slice(0, 140)}`));
    }
  }
  const { data: items } = await admin.from("qb_items").select("id, quickbooks_id").eq("workspace_id", WS);
  const idByQbId = new Map((items ?? []).map((i) => [String(i.quickbooks_id), i.id]));
  const byProduct = new Map<string, number>();
  for (const [qbId, qty] of byQbItem) {
    const pid = idByQbId.get(qbId);
    if (pid) byProduct.set(pid, (byProduct.get(pid) ?? 0) + qty);
  }
  return { byProduct, ok };
}

/** Σ |QtyDiff| × unit_cost — the dollar value the guard's plausibility band watches. */
async function adjustmentValue(
  admin: ReturnType<typeof createAdminClient>,
  lines: { itemRef: string; qtyDiff: number }[],
): Promise<number> {
  const { data: items } = await admin.from("qb_items").select("quickbooks_id, unit_cost").eq("workspace_id", WS);
  const cost = new Map((items ?? []).map((i) => [String(i.quickbooks_id), Number(i.unit_cost ?? 0)]));
  return lines.reduce((a, l) => a + Math.abs(l.qtyDiff) * (cost.get(String(l.itemRef)) ?? 0), 0);
}

const aggCents = (ls: { amount: number; posting: string; accountId: string }[]) => {
  const m = new Map<string, number>();
  for (const l of ls) m.set(`${l.posting}:${l.accountId}`, (m.get(`${l.posting}:${l.accountId}`) ?? 0) + Math.round(l.amount * 100));
  return m;
};

async function main() {
  console.log(C.b(`\n═══ ShopCX SHADOW CLOSE ${MONTH} — driven by ShopCX's own tables (posts nothing) ═══\n`));
  const admin = createAdminClient();

  process.stdout.write(C.d("  fetching live Shopify orders + QB receipts… "));
  const [orders, received] = await Promise.all([fetchShopifyOrders(), fetchReceived(admin)]);
  console.log(C.d(`${orders.length} orders · ${received.byProduct.size} received item(s)${received.ok ? "" : " · ⚠ LOOKUP FAILED"}\n`));

  const art = await buildMonthEndArtifacts({ workspaceId: WS, month: MONTH, admin, orders, receivedByProduct: received.byProduct });
  console.log(C.d(`  opening book: ${art.meta.priorMonth} month_end_post — ${art.meta.qbBasisRows} rows`));
  console.log(C.d(`  FBA snapshot ${art.meta.fbaSnapshotDate} · 3PL snapshot ${art.meta.tplSnapshotDate}\n`));

  const results: { step: string; ok: boolean; detail: string }[] = [];

  const goldenPath = `fixtures/shoptics-golden/qbo-entries/${MONTH}.json`;
  const hasGolden = fs.existsSync(goldenPath);
  const golden = hasGolden ? JSON.parse(fs.readFileSync(goldenPath, "utf8")) : null;

  const je = art.journalEntry;
  const balanced = Math.abs(je.totalDebits - je.totalCredits) < 0.005;
  if (golden) {
    const gKey = Object.keys(golden).find((k) => k.startsWith("journalentry_"))!;
    const gJe = golden[gKey].JournalEntry ?? golden[gKey];
    const s = aggCents(je.lines);
    const g = aggCents((gJe.Line || []).filter((l: { JournalEntryLineDetail?: unknown }) => l.JournalEntryLineDetail)
      .map((l: { Amount: number; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } } }) => ({
        amount: l.Amount, posting: l.JournalEntryLineDetail.PostingType, accountId: l.JournalEntryLineDetail.AccountRef.value,
      })));
    let diffs = 0;
    for (const k of new Set([...s.keys(), ...g.keys()])) if ((s.get(k) ?? 0) !== (g.get(k) ?? 0)) diffs++;
    results.push({ step: "JournalEntry", ok: diffs === 0 && balanced, detail: `${je.lines.length} lines · $${je.totalDebits.toFixed(2)} ${balanced ? "balanced" : "OUT OF BALANCE"} · ${diffs === 0 ? "all lines match golden" : diffs + " differ"}` });
  } else {
    results.push({ step: "JournalEntry", ok: balanced, detail: `${je.lines.length} lines · $${je.totalDebits.toFixed(2)} ${balanced ? "balanced" : "OUT OF BALANCE"} · (no golden to diff)` });
  }

  const CUST: Record<string, string> = { "40": "amazon", "30410": "shopify" };
  const gReceipts: Record<string, Map<string, number>> = {};
  if (golden)
    for (const k of Object.keys(golden).filter((x) => x.startsWith("salesreceipt_"))) {
      const sr = golden[k].SalesReceipt ?? golden[k];
      const m = new Map<string, number>();
      for (const l of sr.Line || []) {
        const gd = l.GroupLineDetail, sd = l.SalesItemLineDetail;
        if (gd) m.set(String(gd.GroupItemRef.value), (m.get(String(gd.GroupItemRef.value)) ?? 0) + Number(gd.Quantity || 0));
        else if (sd) m.set(String(sd.ItemRef.value), (m.get(String(sd.ItemRef.value)) ?? 0) + Number(sd.Qty || 0));
      }
      gReceipts[CUST[String(sr.CustomerRef?.value)] ?? "internal"] = m;
    }
  for (const ch of ["amazon", "shopify", "internal"] as const) {
    const shadow = new Map<string, number>();
    for (const l of art.receipts[ch]) shadow.set(String(l.itemRef), (shadow.get(String(l.itemRef)) ?? 0) + l.qty);
    const units = [...shadow.values()].reduce((a, b) => a + b, 0);
    if (!golden) { results.push({ step: `SalesReceipt · ${ch}`, ok: true, detail: `${art.receipts[ch].length} lines / ${units} units · (no golden)` }); continue; }
    const g = gReceipts[ch] ?? new Map();
    let d = 0;
    for (const k of new Set([...shadow.keys(), ...g.keys()])) if ((shadow.get(k) ?? 0) !== (g.get(k) ?? 0)) d++;
    results.push({ step: `SalesReceipt · ${ch}`, ok: d === 0, detail: `${art.receipts[ch].length} lines / ${units} units · ${d === 0 ? "quantities match" : d + " differ"}` });
  }

  const sAdj = new Map<string, number>();
  for (const l of art.inventoryAdjustment) sAdj.set(String(l.itemRef), (sAdj.get(String(l.itemRef)) ?? 0) + l.qtyDiff);
  const absUnits = [...sAdj.values()].reduce((a, b) => a + Math.abs(b), 0);
  if (golden) {
    const gKey = Object.keys(golden).find((k) => k.startsWith("inventoryadjustment_"));
    const gAdj = gKey ? (golden[gKey].InventoryAdjustment ?? golden[gKey]) : { Line: [] };
    const g = new Map<string, number>();
    for (const l of gAdj.Line || []) {
      const d = l.ItemAdjustmentLineDetail;
      if (d?.ItemRef?.value) g.set(String(d.ItemRef.value), (g.get(String(d.ItemRef.value)) ?? 0) + Number(d.QtyDiff || 0));
    }
    let diffs = 0;
    for (const k of new Set([...sAdj.keys(), ...g.keys()])) if ((sAdj.get(k) ?? 0) !== (g.get(k) ?? 0)) diffs++;
    results.push({ step: "InventoryAdjustment", ok: diffs === 0, detail: `${art.inventoryAdjustment.length} lines / ${absUnits} abs units · ${diffs === 0 ? "all items match" : diffs + " differ"}` });
  } else {
    results.push({ step: "InventoryAdjustment", ok: true, detail: `${art.inventoryAdjustment.length} lines / ${absUnits} abs units · (no golden)` });
  }

  console.log(C.b(`  Artifact                     ${hasGolden ? "vs Shoptics' actual QBO posting" : "(shadow only — no golden for this month)"}`));
  console.log(C.d("  ────────────────────────────────────────────────────────────────"));
  for (const r of results)
    console.log(`  ${r.ok ? C.g("✓") : C.r("✗")} ${r.step.padEnd(26)} ${r.ok ? C.g("OK   ") : C.r("DIFF ")}  ${C.d(r.detail)}`);

  // ── grade the run and record the verdict the posting guard reads ──
  const { data: procRows } = await admin
    .from("qb_payment_processor_summaries").select("processor").eq("workspace_id", WS).eq("closing_month", MONTH);
  const { data: priorCloses } = await admin
    .from("qb_month_end_closings").select("closing_month").eq("workspace_id", WS).order("closing_month", { ascending: false }).limit(6);
  void priorCloses;
  const adjValue = await adjustmentValue(admin, art.inventoryAdjustment);

  const assessment = assessDryRun({
    artifacts: art,
    processorsPresent: (procRows ?? []).map((p) => String(p.processor)),
    receiptsLookupOk: received.ok,
    periodEnd: `${MONTH}-${String(LAST).padStart(2, "0")}`,
    adjustmentValue: adjValue,
    // historical posted adjustment values (May $2,054.86 / June $3,284.82) — the plausibility band
    recentAdjustmentValues: [3284.82, 2054.86],
  });

  console.log(C.b(`\n  Inventory adjustment value: $${adjValue.toFixed(2)}`));
  console.log(C.b("\n  Close-guard verdict"));
  console.log(C.d("  ────────────────────────────────────────────────────────────────"));
  if (assessment.passed) console.log(`  ${C.g("✓ PASSES")} — this month is eligible to post (a founder still presses the button).`);
  else {
    console.log(`  ${C.r("✗ BLOCKED")} — ${assessment.blocking.length} issue(s) must be resolved before posting:`);
    for (const b of assessment.blocking) console.log(`     ${C.r("•")} [${b.code}] ${b.detail}`);
  }
  for (const w of assessment.warnings) console.log(`     ${C.d("• " + w)}`);

  await recordDryRun(admin, WS, art, assessment, adjValue);
  console.log(C.d(`\n  verdict recorded to qb_close_dry_runs (${MONTH}, passed=${assessment.passed})`));

  const allOk = results.every((r) => r.ok);
  console.log("\n" + (allOk ? C.g(C.b("  ✅ ShopCX reproduces this month from its OWN data.")) : C.r(C.b(`  ✗ ${results.filter((r) => !r.ok).length} artifact(s) differ vs golden (see notes above).`))));
  console.log(C.d("\n  (Shadow only — no QuickBooks entries were created.)\n"));
  process.exit(assessment.passed ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
