/**
 * BLENDED CAC vs spend level — the operator's frame (CEO 2026-08-24).
 *
 * "It doesn't matter if a customer would have arrived anyway, because we will
 *  never know. Hoping an organic customer shows up is not a lever."
 *
 * Correct. The lever is ad spend; the metric is total spend / total new
 * customers across BOTH channels. This measures how blended CAC actually
 * behaved as spend moved 8x, and answers: how far can we scale before
 * LTV:CAC drops below target?
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BLENDED_LTV = Number(process.env.BLENDED_LTV ?? 208.93); // dashboard, July
const TARGET_RATIO = 3;

async function pageAll(admin: ReturnType<typeof createAdminClient>, table: string, cols: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols)
      .eq("workspace_id", WS).gte("snapshot_date", "2025-01-01").range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();
  const spendRows = await pageAll(admin, "daily_meta_ad_spend", "snapshot_date,spend_cents");
  const amzRows = await pageAll(admin, "daily_amazon_order_snapshots", "snapshot_date,order_bucket,order_count");
  const siteRows = await pageAll(admin, "daily_order_snapshots", "snapshot_date,new_subscription_count,one_time_count");

  const M = (d: string) => String(d).slice(0, 7);
  const spend: Record<string, number> = {}, acq: Record<string, number> = {};
  for (const r of spendRows) spend[M(String(r.snapshot_date))] = (spend[M(String(r.snapshot_date))] ?? 0) + Number(r.spend_cents ?? 0) / 100;
  for (const r of amzRows) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    acq[M(String(r.snapshot_date))] = (acq[M(String(r.snapshot_date))] ?? 0) + Number(r.order_count ?? 0);
  }
  for (const r of siteRows) acq[M(String(r.snapshot_date))] = (acq[M(String(r.snapshot_date))] ?? 0)
    + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const months = Object.keys(spend).filter((m) => acq[m] && m < thisMonth).sort();

  console.log("=== BLENDED CAC AS SPEND MOVED 8x ===");
  console.log("month     MetaSpend   newCustomers   blendedCAC   LTV:CAC");
  for (const m of months) {
    const cac = spend[m] / acq[m];
    console.log(`${m}   ${("$" + spend[m].toFixed(0)).padStart(9)}   ${String(acq[m]).padStart(12)}   ${("$" + cac.toFixed(0)).padStart(10)}   ${(BLENDED_LTV / cac).toFixed(1)}x`);
  }

  // Bucket by spend level to see the curve without month-to-month noise.
  console.log("\n=== THE SCALE CURVE (months grouped by spend level) ===");
  const buckets: Array<[string, number, number]> = [
    ["under $50K/mo", 0, 50000],
    ["$50-120K/mo", 50000, 120000],
    ["$120-180K/mo", 120000, 180000],
    ["over $180K/mo", 180000, Infinity],
  ];
  console.log("  spend band        n   avgSpend   avgCustomers   blendedCAC   LTV:CAC");
  for (const [label, lo, hi] of buckets) {
    const set = months.filter((m) => spend[m] >= lo && spend[m] < hi);
    if (!set.length) continue;
    const s = set.reduce((a, m) => a + spend[m], 0) / set.length;
    const c = set.reduce((a, m) => a + acq[m], 0) / set.length;
    const cac = s / c;
    console.log(`  ${label.padEnd(16)} ${String(set.length).padStart(2)}   ${("$" + (s / 1000).toFixed(0) + "K").padStart(8)}   ${c.toFixed(0).padStart(12)}   ${("$" + cac.toFixed(0)).padStart(10)}   ${(BLENDED_LTV / cac).toFixed(1)}x`);
  }

  // ── what did scaling actually cost in CURRENT profit? ──
  console.log("\n=== WHY 2025 WASN'T PROFITABLE DESPITE GOOD LTV:CAC ===");
  const { data: pnl } = await admin.from("qb_pnl_snapshots")
    .select("period_month,total_income,adjusted_net_income,digital_advertising")
    .eq("workspace_id", WS).order("period_month", { ascending: true });
  console.log("month     income   adSpend   profit   margin   customersAcquired   LTV acquired   LTV:spend");
  for (const r of pnl ?? []) {
    const m = String(r.period_month).slice(0, 7);
    if (!acq[m]) continue;
    const inc = Number(r.total_income), p = Number(r.adjusted_net_income), a = Number(r.digital_advertising);
    const ltvAcq = acq[m] * BLENDED_LTV;
    console.log(
      `${m}   ${("$" + (inc / 1000).toFixed(0) + "K").padStart(6)}   ${("$" + (a / 1000).toFixed(0) + "K").padStart(7)}  ${((p < 0 ? "-$" : "$") + Math.abs(p / 1000).toFixed(0) + "K").padStart(7)}   ${((p / inc) * 100).toFixed(1).padStart(5)}%   ${String(acq[m]).padStart(17)}   ${("$" + (ltvAcq / 1000).toFixed(0) + "K").padStart(12)}   ${(ltvAcq / a).toFixed(1)}x`
    );
  }

  console.log("\n=== HOW FAR CAN WE SCALE? ===");
  console.log(`  (blended LTV $${BLENDED_LTV.toFixed(0)}, target LTV:CAC ${TARGET_RATIO}x → CAC ceiling $${(BLENDED_LTV / TARGET_RATIO).toFixed(0)})`);
  const cacCeiling = BLENDED_LTV / TARGET_RATIO;
  for (const [label, lo, hi] of buckets) {
    const set = months.filter((m) => spend[m] >= lo && spend[m] < hi);
    if (!set.length) continue;
    const s = set.reduce((a, m) => a + spend[m], 0) / set.length;
    const c = set.reduce((a, m) => a + acq[m], 0) / set.length;
    const cac = s / c;
    console.log(`  ${label.padEnd(16)} CAC $${cac.toFixed(0)}  ${cac <= cacCeiling ? `✅ under the $${cacCeiling.toFixed(0)} ceiling` : `❌ over the ceiling`}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
