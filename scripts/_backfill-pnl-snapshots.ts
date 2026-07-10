/**
 * Backfill the last 24 CLOSED months of QuickBooks P&L into qb_pnl_snapshots for Superfoods,
 * driving shopcx's OWN QBO client (src/lib/quickbooks.ts) end-to-end. Prints Revenue (total_income)
 * + Profit (net_income) per month — the two CEO north-star lines.
 *
 * Run: npx tsx scripts/_backfill-pnl-snapshots.ts
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { backfillPnlSnapshots } from "../src/lib/quickbooks";

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const fmt = (n: number | null) => (n === null ? "     —    " : n.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(10));

async function main() {
  console.log("backfilling 24 closed months of P&L via shopcx QBO client …\n");
  const rows = await backfillPnlSnapshots(SUPERFOODS_WORKSPACE_ID, 24);
  console.log("month        Revenue   Net Profit  MgmtFees  Profit+Addbacks");
  console.log("---------------------------------------------------------------");
  for (const r of rows) {
    console.log(`${r.period_month}  ${fmt(r.total_income)}  ${fmt(r.net_income)}  ${fmt(r.management_fees)}  ${fmt(r.adjusted_net_income)}`);
  }
  // fiscal-year (Jan–Dec) BOOKED net-profit rollup — the ≤$0 US-tax target
  const byFY = new Map<string, number>();
  for (const r of rows) {
    const fy = r.period_month.slice(0, 4);
    byFY.set(fy, (byFY.get(fy) ?? 0) + (r.net_income ?? 0));
  }
  console.log("\n=== fiscal-year BOOKED net profit (goal: ≤ $0 to avoid US tax) ===");
  for (const [fy, v] of [...byFY].sort()) console.log(`  FY${fy}: ${fmt(v)}  ${v <= 0 ? "✓ under ceiling" : "⚠ ABOVE $0"}  ${fy === "2024" || fy === "2026" ? "(partial year in this 24-mo window)" : ""}`);
  console.log(`\n✓ ${rows.length} monthly snapshots upserted into qb_pnl_snapshots`);
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
