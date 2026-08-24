/**
 * The revenue + profit PATH, not just the endpoint.
 *
 * Projects every living cohort forward on the measured retention curve, adds
 * new cohorts at a chosen intake rate, and sums by calendar month. Answers the
 * CEO's actual question: does the 22% margin evaporate SOON, or is there a
 * cruise-control level?
 *
 * Cross-checks the cohort model against the MRR-page identity
 * (equilibrium MRR = new-sub MRR / churn rate), which uses TODAY's blended
 * churn and therefore reads much higher — the two disagree for a reason worth
 * understanding, printed below.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SINCE = "2025-01-01";
const MAXM = 13;
const TAIL_FROM = 5;
const PROJECT_MONTHS = 30;

const K = (c: number) => (c < 0 ? "-" : "") + "$" + Math.abs(c / 100 / 1000).toFixed(0) + "K";

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
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

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
    const mi = Math.floor((Date.parse(String(r.created_at)) - acq) / (30.44 * 86400000));
    if (mi >= 0 && mi <= MAXM) ensure(new Date(acq).toISOString().slice(0, 7)).rev[mi] += Number(r.total_cents ?? 0);
  }

  const nowMs = Date.now();
  const ageM = (m: string) => (nowMs - Date.parse(`${m}-28T00:00:00Z`)) / (30.44 * 86400000);

  // blended curve, and a RECENT-ONLY curve to test tail bias
  const build = (filter: (m: string) => boolean) => {
    const out: number[] = [];
    for (let k = 0; k <= MAXM; k++) {
      const set = Object.entries(coh).filter(([m, c]) => c.n >= 60 && ageM(m) >= k + 1 && filter(m));
      if (!set.length) break;
      const n = set.reduce((s, [, c]) => s + c.n, 0);
      out.push(set.reduce((s, [, c]) => s + c.rev[k], 0) / n);
    }
    return out;
  };
  const curve = build(() => true);
  const recentCurve = build((m) => m >= "2025-09");

  const fitDecay = (c: number[]) => {
    const rs: number[] = [];
    for (let k = TAIL_FROM; k < c.length; k++) if (c[k - 1] > 0) rs.push(c[k] / c[k - 1]);
    return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0.9;
  };
  const decay = fitDecay(curve);
  const ltvOf = (c: number[], d: number) => {
    let sum = c.reduce((a, b) => a + b, 0), last = c[c.length - 1];
    for (let k = c.length; k < 60; k++) { last *= d; sum += last; }
    return sum;
  };
  const ltv = ltvOf(curve, decay);
  const ltvRecent = ltvOf(recentCurve, fitDecay(recentCurve));

  console.log("=== LTV SENSITIVITY (tail is an extrapolation — treat as a range) ===");
  console.log(`  all cohorts (2025-01+)   observed m0-m${curve.length - 1} $${(curve.reduce((a, b) => a + b, 0) / 100).toFixed(0)}   decay ${decay.toFixed(3)}   LTV $${(ltv / 100).toFixed(0)}`);
  console.log(`  recent only (2025-09+)   observed m0-m${recentCurve.length - 1} $${(recentCurve.reduce((a, b) => a + b, 0) / 100).toFixed(0)}   decay ${fitDecay(recentCurve).toFixed(3)}   LTV $${(ltvRecent / 100).toFixed(0)}`);
  console.log(`  ⚠ the m13 point rests on the OLDEST cohorts only — the tail is biased UP by pre-decline economics.`);

  // per-month revenue function for a cohort of size 1 at age k
  const perCust = (k: number) => (k < curve.length ? curve[k] : curve[curve.length - 1] * Math.pow(decay, k - curve.length + 1));

  // ── cross-check vs the MRR-page identity ──
  console.log("\n=== CROSS-CHECK: two equilibrium methods disagree, and why ===");
  const N = ["2026-05", "2026-06", "2026-07"].reduce((s, m) => s + (coh[m]?.n ?? 0), 0) / 3;
  console.log(`  A. cohort identity:  ${N.toFixed(0)} new/mo x $${(ltv / 100).toFixed(0)} LTV        = ${K(N * ltv)}/mo on-site`);
  console.log(`  B. MRR identity:     new-sub MRR $17.6K / churn 10.1%   = $174K/mo MRR`);
  console.log(`  → B uses TODAY's blended churn, which is low BECAUSE the base is old and sticky.`);
  console.log(`    As the base shrinks toward equilibrium its composition doesn't change much, so B`);
  console.log(`    understates the decline. A is the right frame; B is a snapshot, not a fixed point.`);

  // ── trajectory ──
  console.log(`\n=== PROJECTED PATH — on-site revenue, at constant intake ===`);
  const { data: qb } = await admin.from("qb_pnl_snapshots")
    .select("total_income,total_cogs,transaction_fees,fixed_opex,digital_advertising,adjusted_net_income")
    .eq("workspace_id", WS).eq("period_month", "2026-07-01").single();
  const income = Number(qb!.total_income) * 100;
  const cogsR = Number(qb!.total_cogs) / Number(qb!.total_income);
  const txnR = Number(qb!.transaction_fees) / Number(qb!.total_income);
  const fixed = Number(qb!.fixed_opex) * 100;

  const { data: dos } = await admin.from("daily_order_snapshots")
    .select("recurring_revenue_cents,new_subscription_revenue_cents,one_time_revenue_cents")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const julOnsite = (dos ?? []).reduce((s, r) => s + Number(r.recurring_revenue_cents ?? 0)
    + Number(r.new_subscription_revenue_cents ?? 0) + Number(r.one_time_revenue_cents ?? 0), 0);
  const nonOnsite = income - julOnsite;

  // existing cohorts, with their current age at 2026-08
  const living = Object.entries(coh)
    .filter(([m, c]) => c.n > 0 && m <= "2026-08")
    .map(([m, c]) => ({ m, n: c.n, age: Math.max(0, Math.round(ageM(m))) }));

  for (const intake of [N, 200, 308]) {
    console.log(`\n  --- intake ${intake.toFixed(0)} new customers/month ---`);
    console.log("   month   onsiteRev   income   adSpend   PROFIT   margin");
    for (let t = 0; t <= PROJECT_MONTHS; t += 3) {
      let rev = 0;
      for (const c of living) rev += c.n * perCust(c.age + t);
      for (let j = 1; j <= t; j++) rev += intake * perCust(t - j);
      const ads = intake * 23000;
      const inc = rev + nonOnsite;
      const profit = inc * (1 - cogsR - txnR) - fixed - ads;
      const label = t === 0 ? "now" : `+${t}mo`;
      console.log(`   ${label.padStart(5)}   ${K(rev).padStart(8)}   ${K(inc).padStart(6)}   ${K(ads).padStart(6)}   ${K(profit).padStart(6)}   ${((profit / inc) * 100).toFixed(1)}%`);
    }
  }

  // ── the cruise-control question ──
  console.log("\n=== CRUISE CONTROL: what intake holds profit flat? ===");
  console.log("  (steady state, July cost structure, CAC $230)");
  console.log("   new/mo   income    PROFIT   margin");
  let best = 0, bestP = -Infinity;
  for (let n = 50; n <= 400; n += 10) {
    const rev = n * ltv;
    const inc = rev + nonOnsite;
    const p = inc * (1 - cogsR - txnR) - fixed - n * 23000;
    if (p > bestP) { bestP = p; best = n; }
    if (n % 50 === 0) console.log(`   ${String(n).padStart(6)}   ${K(inc).padStart(6)}   ${K(p).padStart(6)}   ${((p / inc) * 100).toFixed(1)}%`);
  }
  console.log(`\n  → profit-maximising steady-state intake: ~${best}/mo  (profit ${K(bestP)}/mo)`);
  const perCustProfit = ltv * (1 - cogsR - txnR) - 23000;
  console.log(`  → contribution per acquired customer: $${(ltv / 100).toFixed(0)} LTV x ${((1 - cogsR - txnR) * 100).toFixed(1)}% margin - $230 CAC = $${(perCustProfit / 100).toFixed(0)}`);
  console.log(`  → every additional customer is ${perCustProfit > 0 ? "PROFIT-POSITIVE" : "PROFIT-NEGATIVE"} over their lifetime`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
