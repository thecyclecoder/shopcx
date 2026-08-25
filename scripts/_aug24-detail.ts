/** Aug 24 detail: verify snapshot counts against raw orders, and split spend by campaign. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  for (const d of ["2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25"]) {
    const { count, error } = await admin.from("orders").select("id", { count: "exact", head: true })
      .eq("workspace_id", WS)
      .gte("created_at", `${d}T00:00:00-05:00`)
      .lt("created_at", `${d}T23:59:59.999-05:00`);
    if (error) throw new Error(error.message);
    console.log(`${d}  raw orders (all buckets, central): ${count}`);
  }

  const { data, error } = await admin.from("daily_meta_ad_spend")
    .select("snapshot_date,ad_account_id,campaign_name,spend_cents,purchases,purchase_value_cents")
    .eq("workspace_id", WS)
    .in("snapshot_date", ["2026-08-23", "2026-08-24"]);
  if (error) throw new Error(error.message);

  const byCamp: Record<string, { s: number; p: number; v: number }> = {};
  for (const r of data ?? []) {
    const k = `${r.snapshot_date}  ${r.campaign_name ?? r.ad_account_id}`;
    byCamp[k] ??= { s: 0, p: 0, v: 0 };
    byCamp[k].s += Number(r.spend_cents ?? 0) / 100;
    byCamp[k].p += Number(r.purchases ?? 0);
    byCamp[k].v += Number(r.purchase_value_cents ?? 0) / 100;
  }
  console.log("\nspend by campaign:");
  for (const [k, v] of Object.entries(byCamp).sort((a, b) => b[1].s - a[1].s)) {
    console.log(`  ${k.padEnd(58)} $${v.s.toFixed(0).padStart(6)}  meta-purch ${String(v.p).padStart(3)}  meta-rev $${v.v.toFixed(0)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
