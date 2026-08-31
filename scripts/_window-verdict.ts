/**
 * Phase 1 scorecard for an arbitrary window, against the plan AND against the prior week.
 *
 * Phase 1's objective is NOT a spend number — it is the FLAT LINE: new subs >= cancels, so revenue
 * stops declining. Spend/CAC are the levers, the net-sub line is the goal.
 *
 * READ-ONLY. DB-only.
 */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const A_FROM = process.env.A_FROM ?? "2026-08-24", A_TO = process.env.A_TO ?? "2026-08-27";
const B_FROM = process.env.B_FROM ?? "2026-08-18", B_TO = process.env.B_TO ?? "2026-08-23";

const TARGET_DAILY_SPEND = 55000 / 30;
const TARGET_DAILY_ACQ = 851 / 30;
const $ = (v: number) => "$" + v.toFixed(0);
const dayOf = (iso: string) => new Date(new Date(iso).getTime() - 5 * 3600_000).toISOString().slice(0, 10);

async function page(admin: ReturnType<typeof createAdminClient>, table: string, cols: string, col: string, from: string, to: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from(table).select(cols).eq("workspace_id", WS)
      .gte(col, from).lte(col, to).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function window(admin: ReturnType<typeof createAdminClient>, from: string, to: string) {
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;

  const spend = (await page(admin, "daily_meta_ad_spend", "spend_cents", "snapshot_date", from, to))
    .reduce((x, r) => x + Number(r.spend_cents ?? 0) / 100, 0);
  const site = await page(admin, "daily_order_snapshots", "new_subscription_count,one_time_count", "snapshot_date", from, to);
  const web = site.reduce((x, r) => x + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0), 0);
  const amz = (await page(admin, "daily_amazon_order_snapshots", "order_bucket,order_count", "snapshot_date", from, to))
    .filter((r) => ["one_time", "sns_checkout"].includes(String(r.order_bucket)))
    .reduce((x, r) => x + Number(r.order_count ?? 0), 0);

  const lo = `${from}T00:00:00-05:00`, hi = `${to}T23:59:59.999-05:00`;
  const subs = await page(admin, "subscriptions", "created_at", "created_at", lo, hi);
  const evts = await page(admin, "customer_events", "customer_id,created_at,event_type", "created_at", lo, hi);
  const cancels = new Set(
    evts.filter((e) => ["subscription.cancelled", "portal.subscription.cancelled"].includes(String(e.event_type)))
      .map((e) => `${e.customer_id}|${String(e.created_at).slice(0, 16)}`),
  ).size;

  // AOV on acquisition orders, to see whether a CAC move is volume or value.
  const orders = await page(admin, "orders", "source_name,tags,subscription_id,total_cents,created_at", "created_at", lo, hi);
  let acqRev = 0, acqN = 0;
  for (const o of orders) {
    const b = bucketOrder(o as never);
    if (b === "new_sub" || b === "one_time") { acqRev += Number(o.total_cents ?? 0) / 100; acqN += 1; }
  }

  return { days, spend, web, amz, total: web + amz, newSubs: subs.length, cancels, net: subs.length - cancels, aov: acqN ? acqRev / acqN : 0 };
}

async function main() {
  const admin = createAdminClient();
  const A = await window(admin, A_FROM, A_TO);
  const B = await window(admin, B_FROM, B_TO);

  const row = (label: string, w: Awaited<ReturnType<typeof window>>) => {
    console.log(`  ${label.padEnd(22)} ${w.days}d  spend ${$(w.spend / w.days).padStart(6)}/day  cust ${(w.total / w.days).toFixed(1).padStart(5)}/day  CAC ${$(w.spend / w.total).padStart(5)}  subs ${(w.newSubs / w.days).toFixed(1)}/day  cancels ${(w.cancels / w.days).toFixed(1)}/day  NET ${(w.net / w.days >= 0 ? "+" : "") + (w.net / w.days).toFixed(1)}/day`);
  };
  console.log("=== WINDOW COMPARISON ===");
  row(`${B_FROM}→${B_TO}`, B);
  row(`${A_FROM}→${A_TO}`, A);

  console.log(`\n=== ${A_FROM} → ${A_TO} vs THE PHASE 1 PLAN ===`);
  const sPd = A.spend / A.days, cPd = A.total / A.days, cac = A.spend / A.total;
  console.log(`  spend           ${$(sPd).padStart(7)}/day   target ${$(TARGET_DAILY_SPEND)}/day    ${(100 * sPd / TARGET_DAILY_SPEND).toFixed(0)}% of plan`);
  console.log(`  new customers   ${cPd.toFixed(1).padStart(7)}/day   target ${TARGET_DAILY_ACQ.toFixed(0)}/day       ${(100 * cPd / TARGET_DAILY_ACQ).toFixed(0)}% of plan`);
  console.log(`  blended CAC     ${$(cac).padStart(7)}       target $65 · hold $110 · break-even $139`);
  console.log(`  acq AOV         ${$(A.aov).padStart(7)}`);

  console.log(`\n=== ⭐ THE ACTUAL PHASE 1 GOAL — the flat line ===`);
  console.log(`  new subs  ${(A.newSubs / A.days).toFixed(1)}/day   cancels ${(A.cancels / A.days).toFixed(1)}/day   NET ${(A.net / A.days >= 0 ? "+" : "") + (A.net / A.days).toFixed(1)}/day`);
  const gapPrev = B.net / B.days, gapNow = A.net / A.days;
  console.log(`  prior window NET ${(gapPrev >= 0 ? "+" : "") + gapPrev.toFixed(1)}/day → now ${(gapNow >= 0 ? "+" : "") + gapNow.toFixed(1)}/day  (${gapNow > gapPrev ? "closing" : gapNow < gapPrev ? "widening" : "flat"})`);
  const needed = Math.max(0, A.cancels / A.days - A.newSubs / A.days);
  console.log(`  to reach flat: +${needed.toFixed(1)} net new subs/day`);
  console.log(`\n  ⚠ The Amazon response to a spend change peaks ~12 days out (docs/brain/functions/cfo/profit-drivers.md).`);
  console.log(`    The Aug-18 ramp's Amazon window opens ~Aug 30 – Sep 5, so this read still under-counts it.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
