/**
 * The breadth plan has a tension: a 25-purchase bar at $150/day takes ~52 days per verdict.
 * This grids (budget per adset) x (purchase bar) and reports what each combination actually buys:
 * concurrent slots needed to hit the spend target, days to a verdict, $ per verdict, verdicts/month,
 * and where each sits against Meta's learning-phase exit (~50 conversions/week).
 *
 * Purchase rate per adset-day is taken from the OBSERVED CPA in that adset's own spend band
 * (meta_insights_daily, adset grain) rather than assumed flat — CPA rises with budget in our data.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET_DAILY = 1833;           // Phase 1, dollars
const BUDGETS = [100, 150, 200, 300, 450];
const BARS = [8, 15, 25];

async function main() {
  const admin = createAdminClient();
  const rows: Array<{ spend_cents: number; purchases: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("meta_insights_daily")
      .select("spend_cents,purchases").eq("workspace_id", WS).eq("level", "adset")
      .gte("snapshot_date", "2026-06-01").range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }

  /** Observed CPA for adset-days near a given daily budget (±40% window). */
  function cpaAt(dailyDollars: number): { cpa: number; n: number } {
    const lo = dailyDollars * 0.6 * 100, hi = dailyDollars * 1.4 * 100;
    const band = rows.filter((r) => r.spend_cents >= lo && r.spend_cents <= hi);
    const s = band.reduce((x, r) => x + r.spend_cents, 0);
    const p = band.reduce((x, r) => x + r.purchases, 0);
    return { cpa: p ? s / p / 100 : NaN, n: band.length };
  }

  console.log("=== OBSERVED CPA AT EACH CANDIDATE TEST BUDGET ===");
  console.log("  budget/day    observed CPA   adset-days in band");
  for (const b of BUDGETS) {
    const { cpa, n } = cpaAt(b);
    console.log(`  $${String(b).padStart(4)}         ${(Number.isNaN(cpa) ? "—" : "$" + cpa.toFixed(0)).padStart(8)}       ${n}`);
  }

  console.log(`\n=== SCENARIO GRID (spend target $${TARGET_DAILY}/day) ===`);
  console.log("  budget  bar   slots   purch/day   days→verdict   $/verdict   verdicts/mo   conv/wk/adset");
  const best: Array<{ label: string; vpm: number; cost: number }> = [];
  for (const b of BUDGETS) {
    const { cpa } = cpaAt(b);
    if (Number.isNaN(cpa)) continue;
    const perDay = b / cpa;                       // purchases per adset per day
    const slots = Math.max(1, Math.round(TARGET_DAILY / b));
    for (const bar of BARS) {
      const days = bar / perDay;
      const costPerVerdict = days * b;
      const verdictsPerMonth = (slots / days) * 30;
      const convWk = perDay * 7;
      best.push({ label: `$${b}/day @ ${bar}p`, vpm: verdictsPerMonth, cost: costPerVerdict });
      console.log(
        `  $${String(b).padStart(4)}  ${String(bar).padStart(3)}   ${String(slots).padStart(5)}   ${perDay.toFixed(2).padStart(9)}   ${days.toFixed(0).padStart(12)}   ${("$" + costPerVerdict.toFixed(0)).padStart(9)}   ${verdictsPerMonth.toFixed(1).padStart(11)}   ${convWk.toFixed(1).padStart(13)}`,
      );
    }
  }

  console.log(`\n  Meta exits the learning phase at ~50 conversions/adset/week.`);
  console.log(`  Every row above is FAR below that — we are learning-limited at any of these budgets.`);
  console.log(`  That is an argument for FEWER, BIGGER adsets, and it cuts against pure breadth.`);

  console.log(`\n=== BEST THROUGHPUT AT EACH STATISTICAL BAR ===`);
  for (const bar of BARS) {
    const cands = BUDGETS
      .map((b) => {
        const { cpa } = cpaAt(b);
        if (Number.isNaN(cpa)) return null;
        const perDay = b / cpa;
        const slots = Math.max(1, Math.round(TARGET_DAILY / b));
        const days = bar / perDay;
        return { b, days, vpm: (slots / days) * 30, cost: days * b, slots };
      })
      .filter(Boolean) as Array<{ b: number; days: number; vpm: number; cost: number; slots: number }>;
    const top = cands.sort((x, y) => y.vpm - x.vpm)[0];
    if (top) {
      console.log(`  ${String(bar).padStart(2)} purchases → best is $${top.b}/day x ${top.slots} slots: ${top.vpm.toFixed(1)} verdicts/mo, ${top.days.toFixed(0)}d each, $${top.cost.toFixed(0)} per verdict`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
