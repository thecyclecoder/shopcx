/**
 * Phase 1 (hold flat) + Phase 2 (ramp) sizing, cash-constrained.
 *
 * CEO 2026-08-24:
 *   Phase 1 — match incoming subs with cancels ("stay flat")
 *   Phase 2 — raise acquisition SLOWLY; Meta is paid on credit cards, so this
 *             month's spend is next month's payment. No $30K -> $100K jumps.
 *
 * The binding constraint is CASH, not CAC. A customer costs money today and
 * repays over ~5 months, so a ramp faster than the payback period compounds the
 * cash gap even when every cohort is profitable.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

/** Total acquisition ≈ BASE + SLOPE_PER_1K × spend$K (19-month OLS, r² 0.83). */
const BASE = 618;
const SLOPE_PER_1K = 7.38;
/** Contribution margin: 1 − COGS 27.4% − txn fees 6.3% (July 2026). */
const CONTRIB = 0.663;
/** Blended LTV per acquired customer (ROAS dashboard, July). */
const LTV = 208.93;
/** Fixed OpEx, flat for two half-years. */
const FIXED = 59000;
/** Hard ceiling: above this a customer costs more than it returns. */
const BREAKEVEN_CAC = LTV * CONTRIB;

const K = (v: number) => (v < 0 ? "-" : "") + "$" + Math.abs(v / 1000).toFixed(0) + "K";

async function main() {
  const admin = createAdminClient();

  // ── current state ──
  const { data: dos } = await admin.from("daily_order_snapshots")
    .select("new_subscription_count,recurring_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const newSubsSite = (dos ?? []).reduce((s, r) => s + Number(r.new_subscription_count ?? 0), 0);

  const { data: amz } = await admin.from("daily_amazon_order_snapshots")
    .select("order_bucket,order_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  let amzAcq = 0, amzSns = 0;
  for (const r of amz ?? []) {
    const b = String(r.order_bucket);
    if (b === "one_time" || b === "sns_checkout") amzAcq += Number(r.order_count ?? 0);
    if (b === "sns_checkout") amzSns += Number(r.order_count ?? 0);
  }

  const { data: spendRows } = await admin.from("daily_meta_ad_spend")
    .select("spend_cents").eq("workspace_id", WS)
    .gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const spend = (spendRows ?? []).reduce((s, r) => s + Number(r.spend_cents ?? 0), 0) / 100;

  const { data: siteAll } = await admin.from("daily_order_snapshots")
    .select("new_subscription_count,one_time_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-07-01").lte("snapshot_date", "2026-07-31");
  const siteCheckouts = (siteAll ?? []).reduce((s, r) =>
    s + Number(r.new_subscription_count ?? 0) + Number(r.one_time_count ?? 0), 0);
  const totalAcq = siteCheckouts + amzAcq;

  console.log("=== CURRENT STATE (July 2026) ===");
  console.log(`  Meta spend                 ${K(spend)}`);
  console.log(`  website checkouts          ${siteCheckouts}   (new subs ${newSubsSite})`);
  console.log(`  Amazon acquisition orders  ${amzAcq}   (SnS signups ${amzSns})`);
  console.log(`  TOTAL new customers        ${totalAcq}   → blended CAC $${(spend / totalAcq).toFixed(0)}`);
  console.log(`\n  break-even CAC = LTV $${LTV.toFixed(0)} x ${(CONTRIB * 100).toFixed(1)}% contribution = $${BREAKEVEN_CAC.toFixed(0)}`);

  // ── PHASE 1: match cancels ──
  // MRR page (July): churn $20.0K/mo vs new-sub MRR $17.6K/mo → net -$2.4K.
  const CHURN_MRR = 20000, NEW_SUB_MRR = 17600;
  const gapPct = CHURN_MRR / NEW_SUB_MRR - 1;
  const subsNeeded = (newSubsSite + amzSns) * (1 + gapPct);
  const acqNeeded = totalAcq * (1 + gapPct);
  const extraCustomers = acqNeeded - totalAcq;
  const extraSpend = (extraCustomers / SLOPE_PER_1K) * 1000;

  console.log("\n=== PHASE 1 — MATCH CANCELS (stay flat) ===");
  console.log(`  churn MRR $${(CHURN_MRR / 1000).toFixed(1)}K vs new-sub MRR $${(NEW_SUB_MRR / 1000).toFixed(1)}K → net ${K(NEW_SUB_MRR - CHURN_MRR)}/mo`);
  console.log(`  gap to close: ${(gapPct * 100).toFixed(1)}% more new subs`);
  console.log(`  → total acquisition ${totalAcq} → ${acqNeeded.toFixed(0)} (+${extraCustomers.toFixed(0)} customers)`);
  console.log(`  → at ${SLOPE_PER_1K}/$1K marginal response: +${K(extraSpend)}/mo of spend`);
  console.log(`\n  PHASE 1 TARGET SPEND: ${K(spend)} → ${K(spend + extraSpend)}/mo   (~$${((spend + extraSpend) / 30).toFixed(0)}/day, up from $${(spend / 30).toFixed(0)})`);
  const p1Cac = (spend + extraSpend) / acqNeeded;
  console.log(`  projected blended CAC at that level: $${p1Cac.toFixed(0)}  ${p1Cac < BREAKEVEN_CAC ? "✅ well under break-even" : "❌ over break-even"}`);

  // ── PHASE 2: ramp scenarios, with cash ──
  console.log("\n=== PHASE 2 — RAMP SCENARIOS (cash-aware) ===");
  console.log("  Cash model: spend leaves this month; a cohort's revenue arrives over the");
  console.log("  retention curve. Card float means month N's spend is month N+1's payment.\n");

  // Monthly revenue realization per acquired customer (blended-LTV shaped to the
  // measured curve: heavy m0, then a long tail).
  const CURVE = [0.40, 0.11, 0.07, 0.06, 0.05, 0.04, 0.04, 0.03, 0.03, 0.03, 0.03, 0.02];
  const perCustMonth = (k: number) => (k < CURVE.length ? CURVE[k] * LTV : CURVE[CURVE.length - 1] * LTV * Math.pow(0.94, k - CURVE.length + 1));

  const startSpend = spend + extraSpend;

  // Model INCREMENTAL cash vs the do-nothing baseline (hold spend at today's level).
  // Absolute cash is meaningless here — the existing customer base isn't in these
  // cohorts, so an absolute series would show losses where July actually made $65K.
  // The DELTA is what the card float actually has to fund.
  const baseCust = BASE + SLOPE_PER_1K * (spend / 1000);
  for (const growth of [0.15, 0.25, 0.4]) {
    console.log(`  --- +${(growth * 100).toFixed(0)}%/month from ${K(startSpend)}, vs holding at ${K(spend)} ---`);
    console.log("   month   spend    newCust    CAC    extra spend   extra revenue   NET cash/mo   cumulative");
    let cum = 0;
    let worst = 0;
    let breakEvenMonth = -1;
    const extraCohorts: number[] = [];
    for (let m = 0; m < 18; m++) {
      const s = Math.min(startSpend * Math.pow(1 + growth, m), 180000);
      const cust = BASE + SLOPE_PER_1K * (s / 1000);
      extraCohorts.push(cust - baseCust); // customers we would NOT have had
      let extraRev = 0;
      for (let j = 0; j < extraCohorts.length; j++) {
        extraRev += extraCohorts[j] * perCustMonth(extraCohorts.length - 1 - j);
      }
      const extraSpendM = s - spend;
      const net = extraRev * CONTRIB - extraSpendM;
      cum += net;
      if (cum < worst) worst = cum;
      if (breakEvenMonth < 0 && cum >= 0 && m > 0) breakEvenMonth = m + 1;
      const cac = s / cust;
      if (m % 3 === 0 || m === 17) {
        console.log(`   ${String(m + 1).padStart(5)}   ${K(s).padStart(6)}   ${cust.toFixed(0).padStart(6)}   $${cac.toFixed(0).padStart(3)}   ${K(extraSpendM).padStart(11)}   ${K(extraRev * CONTRIB).padStart(13)}   ${K(net).padStart(11)}   ${K(cum).padStart(10)}`);
      }
    }
    console.log(`   → deepest cash hole ${K(worst)}${breakEvenMonth > 0 ? `, cumulative turns positive month ${breakEvenMonth}` : ", still negative at month 18"}\n`);
  }

  console.log("=== READING IT ===");
  console.log(`  • CAC stays under the $${BREAKEVEN_CAC.toFixed(0)} break-even at every level modelled here.`);
  console.log("  • The trough is the cash cost of growth: spend rises immediately, the cohort");
  console.log("    repays over ~5 months. A faster ramp digs a deeper hole for the same endpoint.");
  console.log("  • Stop-rule while ramping: blended CAC > $100 → hold that level for a month.");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
