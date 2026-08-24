/** Read-only: diagnose per-product vs aggregate drift on daily_amazon_product_snapshots. */
import { createAdminClient } from "./_bootstrap";
const admin = createAdminClient();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { data: prod } = await admin
    .from("daily_amazon_product_snapshots")
    .select("snapshot_date, asin, order_bucket, order_count, gross_revenue_cents, updated_at")
    .eq("workspace_id", WS)
    .eq("snapshot_date", "2026-08-13")
    .eq("order_bucket", "recurring");
  console.log("per-product rows for 2026-08-13 / recurring:");
  for (const r of prod || [])
    console.log(`  ${r.asin}  $${(r.gross_revenue_cents / 100).toFixed(2).padStart(8)}  n=${r.order_count}  updated=${r.updated_at}`);

  const { data: agg } = await admin
    .from("daily_amazon_order_snapshots")
    .select("gross_revenue_cents, order_count")
    .eq("workspace_id", WS)
    .eq("snapshot_date", "2026-08-13")
    .eq("order_bucket", "recurring")
    .maybeSingle();
  console.log(`aggregate: $${((agg?.gross_revenue_cents || 0) / 100).toFixed(2)}  n=${agg?.order_count}`);

  // How widespread: total drift across May–Aug
  // MUST paginate — PostgREST caps an unbounded select at 1000 rows and this table
  // has ~1.5k rows over the window; a truncated read reads as a fake under-count.
  const allP: { snapshot_date: string; order_bucket: string; gross_revenue_cents: number }[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin
      .from("daily_amazon_product_snapshots")
      .select("snapshot_date, order_bucket, gross_revenue_cents")
      .eq("workspace_id", WS)
      .gte("snapshot_date", "2026-05-01")
      .lte("snapshot_date", "2026-08-24")
      .range(off, off + 999);
    if (error) { console.log("ERR", error); return; }
    if (!data || !data.length) break;
    allP.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`(per-product rows read: ${allP.length})`);
  const { data: allA } = await admin
    .from("daily_amazon_order_snapshots")
    .select("snapshot_date, order_bucket, gross_revenue_cents")
    .eq("workspace_id", WS)
    .gte("snapshot_date", "2026-05-01")
    .lte("snapshot_date", "2026-08-24");
  const ps = new Map<string, number>();
  for (const r of allP) {
    const k = `${r.snapshot_date}|${r.order_bucket}`;
    ps.set(k, (ps.get(k) || 0) + r.gross_revenue_cents);
  }
  let pTot = 0, aTot = 0, drifted = 0;
  for (const r of allA || []) {
    const k = `${r.snapshot_date}|${r.order_bucket}`;
    const p = ps.get(k) || 0;
    pTot += p; aTot += r.gross_revenue_cents;
    if (p !== r.gross_revenue_cents) drifted++;
  }
  console.log(`\nMay–Aug: per-product total $${(pTot / 100).toFixed(0)} vs aggregate $${(aTot / 100).toFixed(0)}`);
  console.log(`inflation: $${((pTot - aTot) / 100).toFixed(0)} across ${drifted} drifted (date,bucket) pairs of ${allA?.length}`);
}
main();
