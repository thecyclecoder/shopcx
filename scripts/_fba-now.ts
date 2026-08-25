/** Current FBA position — re-probe (physical = fulfillable + transit; NEVER add reserved/inbound). READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data: latest, error: e0 } = await admin.from("qb_amazon_inventory_snapshots")
    .select("snapshot_date").eq("workspace_id", WS)
    .order("snapshot_date", { ascending: false }).limit(1).maybeSingle();
  if (e0) throw new Error(e0.message);
  const d = String(latest?.snapshot_date);

  const { data, error } = await admin.from("qb_amazon_inventory_snapshots")
    .select("asin,seller_sku,quantity_fulfillable,quantity_inbound,quantity_reserved,quantity_transit")
    .eq("workspace_id", WS).eq("snapshot_date", d);
  if (error) throw new Error(error.message);

  console.log(`FBA snapshot ${d} (${(data ?? []).length} ASINs)`);
  console.log("  sku                          fulfillable  transit  inbound  reserved   PHYSICAL");
  let f = 0, t = 0, inb = 0;
  for (const r of (data ?? []).sort((a, b) => Number(b.quantity_fulfillable) - Number(a.quantity_fulfillable))) {
    const ff = Number(r.quantity_fulfillable), tt = Number(r.quantity_transit), ii = Number(r.quantity_inbound);
    f += ff; t += tt; inb += ii;
    console.log(`  ${String(r.seller_sku ?? r.asin).slice(0, 26).padEnd(26)} ${String(ff).padStart(11)} ${String(tt).padStart(8)} ${String(ii).padStart(8)} ${String(r.quantity_reserved).padStart(9)} ${String(ff + tt).padStart(10)}`);
  }
  console.log(`  ${"TOTAL".padEnd(26)} ${String(f).padStart(11)} ${String(t).padStart(8)} ${String(inb).padStart(8)} ${"".padStart(9)} ${String(f + t).padStart(10)}`);

  // Burn rate from the last 14 days of Amazon acquisition orders
  const from = "2026-08-10";
  const { data: az } = await admin.from("daily_amazon_order_snapshots").select("order_count,order_bucket,snapshot_date")
    .eq("workspace_id", WS).gte("snapshot_date", from).lte("snapshot_date", "2026-08-24");
  const units = (az ?? []).reduce((x, r) => x + Number(r.order_count), 0);
  const days = 15;
  console.log(`\n  all-bucket Amazon orders last ${days}d: ${units} (${(units / days).toFixed(1)}/day)`);
  console.log(`  runway on fulfillable at that order rate: ~${(f / (units / days)).toFixed(0)} days · inbound ${inb === 0 ? "ZERO ⚠" : inb}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
