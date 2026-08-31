/**
 * Where does the business flatten out, and is the 22% margin durable?
 *
 * Two opposing forces (CEO 2026-08-24):
 *   1. revenue declines every month at current acquisition
 *   2. margin is exceptional BECAUSE acquisition is low
 *
 * The steady-state identity for a subscription business:
 *
 *     equilibrium monthly revenue = (new customers / month) x (lifetime revenue / customer)
 *
 * because at equilibrium every living cohort's contribution sums to exactly one
 * cohort's full lifetime. If today's revenue is ABOVE that, revenue declines
 * toward it; below, it grows toward it.
 *
 * A constant-churn model (base* = new / churn%) is WRONG here: churn is
 * front-loaded (the cliff) then flat (the sticky core), so as intake falls the
 * surviving base gets stickier and the blended churn rate DROPS. That pushes
 * equilibrium HIGHER than a constant-rate model predicts. We use the measured
 * retention curve with a fitted geometric tail instead.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SINCE = "2025-01-01";
const MAXM = 13;               // months since acquisition we can observe
const TAIL_FIT_FROM = 5;       // fit the geometric tail from this month on
const HORIZON = 60;            // months to project the tail over

const $ = (c: number) => "$" + (c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
const K = (c: number) => "$" + (c / 100 / 1000).toFixed(0) + "K";

async function main() {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("order_source_mapping").eq("id", WS).single();
  const sm = (ws?.order_source_mapping ?? {}) as Record<string, string>;

  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("orders")
      .select("customer_id,created_at,total_cents,source_name,tags,subscription_id")
      .eq("workspace_id", WS).gte("created_at", `${SINCE}T00:00:00Z`)
      .order("created_at", { ascending: true }).range(off, off + 999);
    if (error) throw new Error(`orders: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`orders since ${SINCE}: ${rows.length}\n`);

  // first ACQUISITION order per customer (long lookback — never dedupe in-window)
  const first = new Map<string, number>();
  for (const r of rows) {
    const cid = r.customer_id as string | null;
    if (!cid) continue;
    const b = bucketOrder(r as never, sm);
    if (b !== "new_sub" && b !== "one_time") continue;
    const t = Date.parse(String(r.created_at));
    if (!first.has(cid) || t < first.get(cid)!) first.set(cid, t);
  }

  const coh: Record<string, { n: number; rev: number[] }> = {};
  const ensure = (m: string) => (coh[m] ??= { n: 0, rev: Array(MAXM + 1).fill(0) });
  for (const [, acq] of first) ensure(new Date(acq).toISOString().slice(0, 7)).n++;
  for (const r of rows) {
    const cid = r.customer_id as string | null;
    if (!cid) continue;
    const acq = first.get(cid);
    if (acq == null) continue;
    const t = Date.parse(String(r.created_at));
    if (t < acq) continue;
    const mi = Math.floor((t - acq) / (30.44 * 86400000));
    if (mi <= MAXM) ensure(new Date(acq).toISOString().slice(0, 7)).rev[mi] += Number(r.total_cents ?? 0);
  }

  // ── 1. blended retention curve from cohorts mature enough at each month ──
  const nowMs = Date.now();
  const ageM = (m: string) => (nowMs - Date.parse(`${m}-28T00:00:00Z`)) / (30.44 * 86400000);
  const curve: number[] = [];
  console.log("=== BLENDED REVENUE PER ACQUIRED CUSTOMER, by month since acquisition ===");
  console.log("m    $/cust   cohorts   (only cohorts fully past that month)");
  for (let k = 0; k <= MAXM; k++) {
    const mature = Object.entries(coh).filter(([m, c]) => c.n >= 60 && ageM(m) >= k + 1);
    if (!mature.length) break;
    const n = mature.reduce((s, [, c]) => s + c.n, 0);
    const rev = mature.reduce((s, [, c]) => s + c.rev[k], 0);
    curve.push(rev / n);
    console.log(`${String(k).padStart(2)}   ${$(rev / n).padStart(7)}     ${String(mature.length).padStart(2)}`);
  }

  // ── 2. fit the geometric tail ──
  const ratios: number[] = [];
  for (let k = TAIL_FIT_FROM; k < curve.length; k++) {
    if (curve[k - 1] > 0) ratios.push(curve[k] / curve[k - 1]);
  }
  const decay = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0.85;
  const observed = curve.reduce((a, b) => a + b, 0);
  let tail = 0;
  let last = curve[curve.length - 1];
  for (let k = curve.length; k < HORIZON; k++) { last *= decay; tail += last; }
  const ltv = observed + tail;

  console.log(`\n=== LIFETIME REVENUE PER ACQUIRED CUSTOMER ===`);
  console.log(`  observed m0-m${curve.length - 1}   ${$(observed)}`);
  console.log(`  fitted tail decay   ${decay.toFixed(3)}/mo  (from m${TAIL_FIT_FROM}, n=${ratios.length} ratios)`);
  console.log(`  projected tail      ${$(tail)}   → implied avg life ${(1 / (1 - decay)).toFixed(1)} more months`);
  console.log(`  LTV (revenue)       ${$(ltv)}`);

  // ── 3. current acquisition rate ──
  console.log("\n=== CURRENT ACQUISITION RATE (on-site new customers/month) ===");
  const recent: Array<{ m: string; n: number }> = [];
  for (const [m, c] of Object.entries(coh).sort()) {
    if (m < "2026-03") continue;
    recent.push({ m, n: c.n });
  }
  for (const r of recent) console.log(`  ${r.m}   ${r.n}`);
  const settled = recent.filter((r) => r.m >= "2026-05" && r.m <= "2026-07");
  const N = settled.reduce((s, r) => s + r.n, 0) / settled.length;
  console.log(`  → run rate (May-Jul avg): ${N.toFixed(0)}/month`);

  // ── 4. steady state ──
  console.log("\n=== STEADY STATE ===");
  const ssOnsite = N * ltv;
  console.log(`  equilibrium on-site revenue = ${N.toFixed(0)} customers/mo x ${$(ltv)} LTV = ${K(ssOnsite)}/mo`);

  // current on-site revenue for comparison
  const { data: dos } = await admin.from("daily_order_snapshots")
    .select("recurring_revenue_cents,new_subscription_revenue_cents,one_time_revenue_cents")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const julOnsite = (dos ?? []).reduce((s, r) =>
    s + Number(r.recurring_revenue_cents ?? 0) + Number(r.new_subscription_revenue_cents ?? 0) + Number(r.one_time_revenue_cents ?? 0), 0);
  console.log(`  July actual on-site revenue                                    = ${K(julOnsite)}/mo`);
  console.log(`  → still to shed: ${K(julOnsite - ssOnsite)}  (${(((julOnsite - ssOnsite) / julOnsite) * 100).toFixed(0)}% below today)`);

  // ── 5. profit at steady state ──
  const { data: qb } = await admin.from("qb_pnl_snapshots")
    .select("total_income,total_cogs,transaction_fees,fixed_opex,digital_advertising,adjusted_net_income")
    .eq("workspace_id", WS).eq("period_month", "2026-07-01").single();
  if (!qb) return;
  const income = Number(qb.total_income) * 100;
  const cogsR = Number(qb.total_cogs) / Number(qb.total_income);
  const txnR = Number(qb.transaction_fees) / Number(qb.total_income);
  const fixed = Number(qb.fixed_opex) * 100;
  const ads = Number(qb.digital_advertising) * 100;
  const incomeRatio = income / (julOnsite + 0); // on-site only basis for the ratio below
  const amazonJul = income - julOnsite * (income / (julOnsite || 1)) * 0; // keep explicit; Amazon handled as a constant below

  // Treat Amazon + the QBO/internal gap as a constant block, since Amazon
  // acquisition is uncorrelated with Meta spend (see profit-drivers.md).
  const nonOnsiteIncome = income - julOnsite;
  console.log("\n=== PROFIT AT STEADY STATE (July cost structure held) ===");
  console.log(`  July: income ${K(income)}  COGS ${(cogsR * 100).toFixed(1)}%  txn ${(txnR * 100).toFixed(1)}%  fixed ${K(fixed)}  ads ${K(ads)}  → profit ${K(Number(qb.adjusted_net_income) * 100)}`);
  console.log(`  (non-on-site income held constant at ${K(nonOnsiteIncome)} — Amazon is uncorrelated with Meta spend)\n`);

  const profitAt = (onsiteRev: number, adSpend: number) => {
    const inc = onsiteRev + nonOnsiteIncome;
    return inc * (1 - cogsR - txnR) - fixed - adSpend;
  };
  console.log("  scenario                              income    profit    margin");
  const scen: Array<[string, number, number]> = [
    ["July actual", julOnsite, ads],
    ["steady state, same ad spend", ssOnsite, ads],
    ["steady state, zero ad spend", ssOnsite, 0],
  ];
  for (const [label, rev, a] of scen) {
    const p = profitAt(rev, a);
    const inc = rev + nonOnsiteIncome;
    console.log(`  ${label.padEnd(36)} ${K(inc).padStart(6)}   ${K(p).padStart(6)}   ${((p / inc) * 100).toFixed(1)}%`);
  }

  // ── 6. what acquisition rate holds today's revenue / breaks even ──
  console.log("\n=== WHAT ACQUISITION RATE DOES WHAT ===");
  const needHold = julOnsite / ltv;
  console.log(`  to HOLD July on-site revenue (${K(julOnsite)}/mo): ${needHold.toFixed(0)} new customers/mo  (today: ${N.toFixed(0)})`);
  console.log(`  → shortfall ${(needHold - N).toFixed(0)}/mo (${((needHold / N - 1) * 100).toFixed(0)}% more acquisition)`);

  console.log("\n  profit at various acquisition rates (steady state, CAC $230):");
  console.log("  new/mo   onsiteRev   income    adSpend   profit   margin");
  for (const n of [N, 100, 150, 200, 250, 300, needHold]) {
    const rev = n * ltv;
    const a = n * 23000; // $230 CAC in cents
    const p = profitAt(rev, a);
    const inc = rev + nonOnsiteIncome;
    const tag = Math.abs(n - N) < 1 ? "  ← today" : Math.abs(n - needHold) < 1 ? "  ← holds July revenue" : "";
    console.log(`  ${n.toFixed(0).padStart(6)}   ${K(rev).padStart(8)}  ${K(inc).padStart(7)}   ${K(a).padStart(7)}  ${K(p).padStart(7)}   ${((p / inc) * 100).toFixed(1)}%${tag}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
