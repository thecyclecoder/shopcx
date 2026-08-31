/**
 * Daily scorecard against the Phase 1 plan (docs/brain/functions/cfo/profit-drivers.md).
 *
 * Phase 1 target: $55K/month of Meta spend (~$1,830/day) buying ~851 new customers/month
 * (~28/day) at a blended CAC around $65. Stop-rule: hold whenever blended CAC crosses $110.
 * Hard ceiling: $139 (LTV $209 x 66.3% contribution).
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const DAYS = 31;

const TARGET_DAILY_SPEND = 55000 / 30;   // Phase 1
const TARGET_DAILY_ACQ = 851 / 30;
const CAC_HOLD = 110;
const CAC_BREAKEVEN = 139;

const $ = (v: number) => "$" + v.toFixed(0);

async function pageAll(admin: ReturnType<typeof createAdminClient>, table: string, cols: string, from: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols)
      .eq("workspace_id", WS).gte("snapshot_date", from).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const from = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const admin = createAdminClient();

  const spendRows = await pageAll(admin, "daily_meta_ad_spend", "snapshot_date,spend_cents", from);
  const siteRows = await pageAll(admin, "daily_order_snapshots", "snapshot_date,new_subscription_count,one_time_count,new_subscription_revenue_cents,one_time_revenue_cents,recurring_count", from);
  const amzRows = await pageAll(admin, "daily_amazon_order_snapshots", "snapshot_date,order_bucket,order_count", from);

  const spend: Record<string, number> = {}, site: Record<string, number> = {}, amz: Record<string, number> = {};
  const siteRev: Record<string, number> = {}, renew: Record<string, number> = {};
  for (const r of spendRows) spend[String(r.snapshot_date)] = (spend[String(r.snapshot_date)] ?? 0) + Number(r.spend_cents ?? 0) / 100;
  for (const r of siteRows) {
    const d = String(r.snapshot_date);
    site[d] = (site[d] ?? 0) + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0);
    siteRev[d] = (siteRev[d] ?? 0) + (Number(r.new_subscription_revenue_cents ?? 0) + Number(r.one_time_revenue_cents ?? 0)) / 100;
    renew[d] = (renew[d] ?? 0) + Number(r.recurring_count ?? 0);
  }
  for (const r of amzRows) {
    if (!["one_time", "sns_checkout"].includes(String(r.order_bucket))) continue;
    amz[String(r.snapshot_date)] = (amz[String(r.snapshot_date)] ?? 0) + Number(r.order_count ?? 0);
  }

  const days = [...new Set([...Object.keys(spend), ...Object.keys(site)])].sort();
  console.log("date         spend   site  amazon  TOTAL   blended CAC   vs plan");
  for (const d of days) {
    const s = spend[d] ?? 0;
    const w = site[d] ?? 0;
    const a = amz[d] ?? 0;
    const tot = w + a;
    const cac = tot ? s / tot : NaN;
    const verdict = !tot ? "—"
      : cac > CAC_BREAKEVEN ? "❌ over break-even"
      : cac > CAC_HOLD ? "⚠ over hold-rule"
      : "✅ under $110";
    console.log(
      `${d}  ${$(s).padStart(7)}  ${String(w).padStart(4)}  ${String(a).padStart(6)}  ${String(tot).padStart(5)}   ${(tot ? $(cac) : "—").padStart(11)}   ${verdict}`
    );
  }

  const y = days[days.length - 1];
  console.log(`\n=== ${y} vs PHASE 1 PLAN ===`);
  const s = spend[y] ?? 0, w = site[y] ?? 0, a = amz[y] ?? 0, tot = w + a;
  console.log(`  spend          ${$(s).padStart(7)}  vs target ${$(TARGET_DAILY_SPEND)}/day   (${s >= TARGET_DAILY_SPEND ? "at/above" : (100 * s / TARGET_DAILY_SPEND).toFixed(0) + "% of"} plan)`);
  console.log(`  new customers  ${String(tot).padStart(7)}  vs target ${TARGET_DAILY_ACQ.toFixed(0)}/day   (website ${w} + Amazon ${a})`);
  console.log(`  blended CAC    ${(tot ? $(s / tot) : "—").padStart(7)}  hold-rule $${CAC_HOLD} · break-even $${CAC_BREAKEVEN}`);
  console.log(`  renewals       ${String(renew[y] ?? 0).padStart(7)}  (context — not acquisition)`);

  // Trailing 7d, the number that actually matters (a single day is noise)
  const win = days.slice(-7);
  const ts = win.reduce((x, d) => x + (spend[d] ?? 0), 0);
  const ta = win.reduce((x, d) => x + (site[d] ?? 0) + (amz[d] ?? 0), 0);
  console.log(`\n=== TRAILING ${win.length}d (the decision number — a single day is noise) ===`);
  console.log(`  spend ${$(ts)} · new customers ${ta} · blended CAC ${ta ? $(ts / ta) : "—"}`);
  console.log(`  run-rate spend ${$(ts / win.length * 30)}/month vs the $55K Phase 1 target`);
  console.log(`  run-rate acquisition ${(ta / win.length * 30).toFixed(0)}/month vs the ~851 target`);

  console.log("\n⚠ Amazon snapshots can lag a day — a low Amazon count on the newest date may be incomplete, which INFLATES that day's CAC.");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
