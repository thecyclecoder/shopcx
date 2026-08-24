/**
 * Isolate the REAL inventory write-off from an accounting-structure change.
 *
 * Trap: before 2025, ad spend was booked INSIDE COGS as per-channel accounts
 * ("Ads - Facebook - Tabs" etc.); from 2025 it moved to the OpEx line
 * "60510 Digital Advertising" (see docs/brain/tables/qb_pnl_snapshots.md
 * § the ad-account bridge). So 2024's COGS at 63-74% of income is MOSTLY ads,
 * not inventory. Naively normalizing total COGS adds real ad spend back as if
 * it were an error and invents ~43% margins for 2024.
 *
 * Correct comparison: PRODUCT COGS = total_cogs - (ads booked in COGS).
 * `digital_advertising` is already bridged across both eras, so for pre-2025
 * months it IS the in-COGS ad total.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ADS_IN_COGS_BEFORE = "2025-01"; // months before this booked ads inside COGS
const K = (v: number) => (v < 0 ? "-" : "") + "$" + Math.abs(v / 1000).toFixed(0) + "K";

async function main() {
  const admin = createAdminClient();
  const { data } = await admin.from("qb_pnl_snapshots")
    .select("period_month,total_income,total_cogs,digital_advertising,adjusted_net_income,inventory_adjustments")
    .eq("workspace_id", WS).order("period_month", { ascending: true });

  const rows = (data ?? []).map((r) => {
    const m = String(r.period_month).slice(0, 7);
    const income = Number(r.total_income ?? 0);
    const cogs = Number(r.total_cogs ?? 0);
    const ads = Number(r.digital_advertising ?? 0);
    const adsInCogs = m < ADS_IN_COGS_BEFORE ? ads : 0;
    return {
      m, income, cogs, ads, adsInCogs,
      productCogs: cogs - adsInCogs,
      profit: Number(r.adjusted_net_income ?? 0),
      invAdj: Number(r.inventory_adjustments ?? 0),
    };
  }).filter((r) => r.income > 0);

  console.log("=== PRODUCT COGS (ads stripped out of the 2024 COGS section) ===");
  console.log("month     income   totalCOGS   adsInCOGS   PRODUCT COGS   product%   flag");
  for (const r of rows) {
    const pct = (r.productCogs / r.income) * 100;
    const flag = pct > 50 ? "  ⚠️ WRITE-OFF" : pct > 40 ? "  ⚠ elevated" : "";
    console.log(
      `${r.m}  ${K(r.income).padStart(7)}  ${K(r.cogs).padStart(9)}  ${K(r.adsInCogs).padStart(9)}   ${K(r.productCogs).padStart(11)}   ${pct.toFixed(1).padStart(7)}%${flag}`
    );
  }

  // normalize on genuinely clean months
  const clean = rows.filter((r) => r.m >= "2025-04" && r.productCogs / r.income < 0.4);
  const rates = clean.map((r) => r.productCogs / r.income).sort((a, b) => a - b);
  const norm = rates[Math.floor(rates.length / 2)];
  console.log(`\n  normalized product-COGS rate (median of ${clean.length} clean months): ${(norm * 100).toFixed(1)}%`);

  console.log("\n=== EXCESS COGS vs NORMAL — the size of the accounting hit ===");
  let total = 0;
  for (const r of rows) {
    const excess = r.productCogs - r.income * norm;
    if (excess > r.income * 0.08) {
      total += excess;
      console.log(`  ${r.m}   product COGS ${((r.productCogs / r.income) * 100).toFixed(0)}% vs ${(norm * 100).toFixed(0)}% normal   → EXCESS ${K(excess)}   (reported profit ${K(r.profit)} → restated ${K(r.profit + excess)})`);
    }
  }
  console.log(`\n  TOTAL excess COGS across flagged months: ${K(total)}`);

  console.log("\n=== SCALE ECONOMICS, CORRECTLY RESTATED ===");
  console.log("  (profit restated ONLY for the write-off months; ads treated as a real cost throughout)");
  const restated = (r: typeof rows[0]) => {
    const excess = r.productCogs - r.income * norm;
    return excess > r.income * 0.08 ? r.profit + excess : r.profit;
  };
  const bands: Array<[string, number, number]> = [
    ["under $50K ads", 0, 50000],
    ["$50-120K ads", 50000, 120000],
    ["$120-180K ads", 120000, 180000],
    ["over $180K ads", 180000, Infinity],
  ];
  console.log("  ad band            n   avgIncome   avgAds   REPORTED margin   RESTATED margin");
  for (const [label, lo, hi] of bands) {
    const set = rows.filter((r) => r.ads >= lo && r.ads < hi);
    if (!set.length) continue;
    const inc = set.reduce((s, r) => s + r.income, 0) / set.length;
    const ad = set.reduce((s, r) => s + r.ads, 0) / set.length;
    const rep = set.reduce((s, r) => s + r.profit, 0) / set.length;
    const res = set.reduce((s, r) => s + restated(r), 0) / set.length;
    console.log(`  ${label.padEnd(17)} ${String(set.length).padStart(2)}   ${K(inc).padStart(9)}   ${K(ad).padStart(6)}   ${((rep / inc) * 100).toFixed(1).padStart(14)}%   ${((res / inc) * 100).toFixed(1).padStart(14)}%`);
  }

  console.log("\n=== 2025 CALENDAR YEAR ===");
  const y2025 = rows.filter((r) => r.m.startsWith("2025"));
  const inc = y2025.reduce((s, r) => s + r.income, 0);
  const rep = y2025.reduce((s, r) => s + r.profit, 0);
  const res = y2025.reduce((s, r) => s + restated(r), 0);
  console.log(`  income ${K(inc)}   reported real profit ${K(rep)} (${((rep / inc) * 100).toFixed(1)}%)   restated ${K(res)} (${((res / inc) * 100).toFixed(1)}%)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
