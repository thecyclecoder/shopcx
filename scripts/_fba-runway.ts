/**
 * Amazon is ~60% of acquisition. If FBA is empty, ad spend cannot convert there
 * — which caps the ramp regardless of CAC. How much sellable FBA stock is left,
 * and how long does it last at the current Amazon run rate?
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("inventory_levels")
      .select("location,sku,on_hand,inbound,reserved,source_synced_at")
      .eq("workspace_id", WS).range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  const tot = (loc: string, f: (r: Record<string, unknown>) => number) =>
    rows.filter((r) => r.location === loc && !/DMG|DAMAG|SAMPLE|INSERT|TEST|OLD/i.test(String(r.sku)))
      .reduce((s, r) => s + f(r), 0);

  const fbaOnHand = tot("fba", (r) => Number(r.on_hand ?? 0));
  const fbaReserved = tot("fba", (r) => Number(r.reserved ?? 0));
  const fbaInbound = tot("fba", (r) => Number(r.inbound ?? 0));
  const tplOnHand = tot("amplifier_3pl", (r) => Number(r.on_hand ?? 0));
  const tplInbound = tot("amplifier_3pl", (r) => Number(r.inbound ?? 0));

  console.log("=== SELLABLE UNITS BY FULFILMENT PATH ===");
  console.log(`  3PL (website)  on-hand ${tplOnHand.toLocaleString()}   inbound ${tplInbound.toLocaleString()}`);
  console.log(`  FBA (Amazon)   on-hand ${fbaOnHand.toLocaleString()}   inbound ${fbaInbound.toLocaleString()}   reserved ${fbaReserved.toLocaleString()}`);
  console.log(`                 → NET sellable on Amazon: ${(fbaOnHand - fbaReserved).toLocaleString()}`);

  // Amazon run rate: acquisition + SnS renewals, last full month
  const { data: amz } = await admin.from("daily_amazon_order_snapshots")
    .select("order_bucket,order_count,gross_revenue_cents")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  let acqOrders = 0, recOrders = 0;
  for (const r of amz ?? []) {
    const b = String(r.order_bucket);
    const o = Number(r.order_count ?? 0);
    if (b === "recurring") recOrders += o; else acqOrders += o;
  }
  console.log(`\n=== AMAZON RUN RATE (July 2026) ===`);
  console.log(`  acquisition orders ${acqOrders}   recurring ${recOrders}   TOTAL ${acqOrders + recOrders}`);
  const ordersTotal = acqOrders + recOrders;
  const perDay = ordersTotal / 31;
  const net = fbaOnHand - fbaReserved;
  console.log(`  → ${perDay.toFixed(1)} orders/day`);
  console.log(`  → FBA runway at ~1 unit/order: ${perDay > 0 ? (net / perDay).toFixed(0) : "—"} days`);

  // Share of acquisition that depends on Amazon
  const { data: site } = await admin.from("daily_order_snapshots")
    .select("new_subscription_count,one_time_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const siteAcq = (site ?? []).reduce((s, r) => s + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0), 0);
  const share = acqOrders / (siteAcq + acqOrders);
  console.log(`\n=== WHAT THIS DOES TO THE RAMP ===`);
  console.log(`  July acquisition: website ${siteAcq} + Amazon ${acqOrders} = ${siteAcq + acqOrders}`);
  console.log(`  Amazon share: ${(share * 100).toFixed(0)}%`);
  console.log(`\n  The 7.38 customers/$1K marginal response was measured with FBA IN STOCK.`);
  console.log(`  With Amazon unable to ship, only the website ${((1 - share) * 100).toFixed(0)}% can convert:`);
  const degraded = 7.38 * (1 - share);
  console.log(`    effective response  ≈ ${degraded.toFixed(2)} customers per $1K`);
  console.log(`    implied marginal CAC ≈ $${(1000 / degraded).toFixed(0)}   (vs $139 break-even)`);
  console.log(`\n  → ramping into an out-of-stock Amazon is buying customers at roughly`);
  console.log(`    ${((1000 / degraded) / 139).toFixed(1)}x break-even. Restock FBA before Phase 2.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
