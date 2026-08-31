/** How much daily history do we actually have for spend / website / Amazon? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function span(admin: ReturnType<typeof createAdminClient>, table: string) {
  const lo = await admin.from(table).select("snapshot_date").eq("workspace_id", WS)
    .order("snapshot_date", { ascending: true }).limit(1).maybeSingle();
  const hi = await admin.from(table).select("snapshot_date").eq("workspace_id", WS)
    .order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  const { count } = await admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`  ${table.padEnd(34)} ${String(lo.data?.snapshot_date)} → ${String(hi.data?.snapshot_date)}   ${count} rows`);
}

async function main() {
  const admin = createAdminClient();
  for (const t of ["daily_meta_ad_spend", "daily_order_snapshots", "daily_amazon_order_snapshots"]) await span(admin, t);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
