/**
 * Read-only validation of the Amazon ROAS snapshot rollup.
 * Run before + after `scripts/backfill-amazon-product-snapshots.ts --apply`
 * to confirm the sync-window hotfix recovered the missing revenue.
 */
import { createAdminClient } from "./_bootstrap";
const admin = createAdminClient();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { data, error } = await admin
    .from("daily_amazon_order_snapshots")
    .select("snapshot_date, order_bucket, order_count, gross_revenue_cents")
    .eq("workspace_id", WS)
    .gte("snapshot_date", "2026-05-01")
    .lte("snapshot_date", "2026-08-24");
  if (error) {
    console.log("ERR", error);
    return;
  }
  const m = new Map<string, { roas: number; rec: number; nR: number; nRec: number }>();
  for (const r of data || []) {
    const k = r.snapshot_date.slice(0, 7);
    const e = m.get(k) || { roas: 0, rec: 0, nR: 0, nRec: 0 };
    if (r.order_bucket === "recurring") {
      e.rec += r.gross_revenue_cents;
      e.nRec += r.order_count;
    } else {
      e.roas += r.gross_revenue_cents;
      e.nR += r.order_count;
    }
    m.set(k, e);
  }
  console.log("month    | ROAS-eligible (dashboard)  | recurring (excluded)    | total");
  for (const k of [...m.keys()].sort()) {
    const e = m.get(k)!;
    console.log(
      `${k}  | $${(e.roas / 100).toFixed(0).padStart(7)} (${String(e.nR).padStart(4)} ord)      | ` +
        `$${(e.rec / 100).toFixed(0).padStart(7)} (${String(e.nRec).padStart(4)} ord)   | ` +
        `$${((e.roas + e.rec) / 100).toFixed(0)}`,
    );
  }
}
main();
