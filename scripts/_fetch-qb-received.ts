// Read-only: fetch the month's inventory RECEIVED (QB Bill/ItemReceipt/Purchase, summed
// ItemBasedExpenseLineDetail.Qty by ItemRef) — the audit's `received` term. Ported from
// Shoptics fetchInventoryReceiptsByItem, via ShopCX's own qboFetch (same realm). Writes
// a {itemRef: qty} json. Usage: _fetch-qb-received.ts 2026-06 <out.json>
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { qboFetch } from "../src/lib/quickbooks";
import * as fs from "fs";

const MONTH = process.argv[2] || "2026-06";
const OUT = process.argv[3] || `/private/tmp/qb-received-${MONTH}.json`;
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const [y, mo] = MONTH.split("-").map(Number);
const start = `${MONTH}-01`, end = new Date(y, mo, 0).toISOString().split("T")[0];

(async () => {
  const admin = createAdminClient();
  const received = new Map<string, number>();
  for (const entity of ["Bill", "ItemReceipt", "Purchase"]) {
    const query = `SELECT * FROM ${entity} WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' MAXRESULTS 1000`;
    let data: any;
    try { data = await qboFetch(WS, "query", { query: { query }, admin }); }
    catch (e) { console.log(`  ${entity}: skip (${(e as Error).message})`); continue; }
    const rows = data.QueryResponse?.[entity] || [];
    let lineHits = 0;
    for (const txn of rows) for (const line of txn.Line || []) {
      const d = line.ItemBasedExpenseLineDetail;
      if (!d?.ItemRef?.value || d.Qty === undefined) continue;
      const qty = Number(d.Qty) || 0; if (qty === 0) continue;
      received.set(String(d.ItemRef.value), (received.get(String(d.ItemRef.value)) || 0) + qty); lineHits++;
    }
    console.log(`  ${entity}: ${rows.length} txns, ${lineHits} item lines`);
  }
  const obj = Object.fromEntries(received);
  fs.writeFileSync(OUT, JSON.stringify(obj, null, 2));
  console.log(`\n  ${received.size} items received in ${MONTH} → ${OUT}`);
  console.log("  item 7 received:", received.get("7") ?? 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
