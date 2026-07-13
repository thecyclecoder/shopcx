/**
 * /ad-testing-results — the per-test funnel across every hero product. Thin renderer over
 * src/lib/ads/testing-results-sdk.ts (all composition/attribution/tiering lives there). Prints one
 * row per test (ad set), grouped by product → test campaign, sorted crowning-potential → early dud.
 *
 *   npx tsx scripts/ad-testing-results.ts
 *
 * Numbers are cumulative-lifetime from meta_insights_daily (adset), kept fresh + today-inclusive by
 * the 2-hourly media-buyer-test-cadence cron — the SAME numbers Bianca acts on. READ-ONLY.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getTestingResults, type TestTier, type TestAdsetRow } from "../src/lib/ads/testing-results-sdk";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

const TIER_LABEL: Record<TestTier, string> = { crown: "👑 CROWN", promising: "📈 PROMISING", testing: "⏳ TESTING", dud: "💀 DUD" };
const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;
const usdOrDash = (cents: number | null) => (cents == null ? "—" : usd(cents));
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

function row(r: TestAdsetRow): string {
  const name = r.adsetName || r.adsetId;
  return [
    "   ",
    pad(TIER_LABEL[r.tier], 13),
    pad(r.active ? "●live" : "○paused", 8),
    pad(name, 30),
    padL(usd(r.spendCents), 8),
    padL(usdOrDash(r.cpmCents === 0 ? null : r.cpmCents), 6), // CPM
    padL(`${r.ctrPct}%`, 6),
    padL(String(r.addToCart), 5),
    padL(usdOrDash(r.costPerAtcCents), 7), // cost/ATC
    padL(String(r.purchases), 4),
    padL(usdOrDash(r.cacCents), 7), // CAC
  ].join(" ");
}

async function main() {
  const admin = createAdminClient();
  const res = await getTestingResults(admin, WORKSPACE_ID);

  console.log(`\n═══ AD TESTING RESULTS — ${res.generatedAt.slice(0, 16).replace("T", " ")} UTC ═══`);
  const t = res.thresholds;
  console.log(
    `Crown: ≥${t.crownMinPurchases} purch @ CAC ≤ ${usd(t.crownMaxCpaCents)} @ ≥ ${usd(t.crownMinSpendCents)} spend · ` +
      `Hold band ≤ ${usd(t.holdBandMaxCpaCents)} · Deadline ${usd(t.maxTestSpendCents)} · Early-trim ≥ ${usd(t.earlyTrimMinSpendCents)} w/ 0 sales`,
  );
  console.log("Numbers: cumulative lifetime, today-inclusive (meta_insights_daily, 2h cadence).\n");

  for (const g of res.products) {
    const camps = g.campaignIds.length ? ` · ${g.campaignIds.length} campaign${g.campaignIds.length > 1 ? "s" : ""}` : "";
    console.log(`■ ${g.productTitle}  —  ${g.metaAccountName}  (${g.activeCount} active${camps})`);
    console.log(
      "   " + pad("verdict", 13) + " " + pad("state", 8) + " " + pad("test (ad set)", 30) +
        " " + padL("spend", 8) + " " + padL("CPM", 6) + " " + padL("CTR", 6) + " " + padL("ATC", 5) +
        " " + padL("$/ATC", 7) + " " + padL("sale", 4) + " " + padL("CAC", 7),
    );
    for (const r of g.rows) console.log(row(r));
    for (const f of g.flags) console.log(`   ⚠ ${f}`);
    console.log("");
  }

  if (res.globalFlags.length) {
    console.log("── STRUCTURE ISSUES ──");
    for (const f of res.globalFlags) console.log(`  ⚠ ${f}`);
    console.log("");
  }

  console.log("── DATA FRESHNESS (per test account) ──");
  for (const f of res.freshness) {
    const age = f.ageHours == null ? "no data" : `${f.ageHours}h ago`;
    console.log(`  ${pad(f.metaAccountName, 24)} latest ${f.latestSnapshot ?? "—"}  refreshed ${age}`);
  }
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
