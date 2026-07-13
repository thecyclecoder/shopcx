// analyze-ad-tests — Max's read-only ad-test analysis lens (thin CLI over ad-insights-sdk).
// Pulls per-ad insights, computes LTV-derived CAC thresholds LIVE, classifies every ad against
// the [[docs/brain/reference/meta-scaling-methodology]] ruleset, and prints verdicts + actions.
// PROPOSES — never mutates ads; spend moves route through Max/CEO.
//
//   npx tsx scripts/analyze-ad-tests.ts [<accountId> ...] [--ltv=N] [--days=30] [--cohort="MB —"]
//   default accounts: Amazing Coffee 2352876514967984 · Superfood Tabs 196487894712827
//   --cohort=<campaign substring>  → restrict to a cohort (e.g. the MB test campaigns) + show the
//                                    add-to-cart leading-indicator funnel per ad.
//
// Purchases use the single canonical `purchase` field (matches Ads Manager) — never the pixel sum.
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
import {
  fetchMetaAdInsights, getDbAdFacts, mergeDbFacts, resolveCacThresholds, classifyAd,
  type AdInsight, type Verdict,
} from "../src/lib/ads/ad-insights-sdk";
import { localDayInTz } from "../src/lib/inngest/media-buyer-test-cadence";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

function icon(v: Verdict) { return v === "winner" ? "🟢" : v === "hold" ? "🟡" : v === "kill" ? "🔴" : "⏳"; }

async function main() {
  const argv = process.argv.slice(2);
  const ltvOverride = argv.find((a) => a.startsWith("--ltv="))?.split("=")[1];
  const days = argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "30";
  const cohort = argv.find((a) => a.startsWith("--cohort="))?.split("=")[1];
  const accounts = argv.filter((a) => !a.startsWith("--"));
  const ACCOUNTS = accounts.length ? accounts : ["2352876514967984", "196487894712827"];
  const nDays = Math.max(1, Number(days) || 30);

  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) { console.error("NO META TOKEN"); process.exit(1); }

  // Account timezones (LA vs Chicago) so the window `until` is each account's OWN today — Meta buckets
  // insights by account tz, and near the UTC boundary account-local "today" is still the prior UTC day.
  const { data: acctRows } = await admin.from("meta_ad_accounts").select("meta_account_id, timezone").in("meta_account_id", ACCOUNTS);
  const tzByAccount = new Map((acctRows ?? []).map((r: { meta_account_id: string; timezone: string | null }) => [r.meta_account_id, r.timezone]));
  const now = new Date();

  const t = await resolveCacThresholds(admin, WS, ltvOverride ? Number(ltvOverride) : undefined);
  console.log(`LTV $${t.ltv.toFixed(0)} (${t.basis}) → target CAC $${t.targetCac.toFixed(0)} · kill $${t.killCac.toFixed(0)} · window last ${nDays}d incl. today${cohort ? ` · cohort "${cohort}"` : ""}`);
  const dbFacts = await getDbAdFacts(admin, WS, {});

  for (const acct of ACCOUNTS) {
    const tz = tzByAccount.get(acct) ?? null;
    const until = localDayInTz(now, tz); // account-local today (inclusive)
    const since = localDayInTz(new Date(now.getTime() - (nDays - 1) * 86400000), tz);
    console.log(`\n════ act_${acct}${cohort ? ` · ${cohort}` : ""} · ${since}…${until} (${tz ?? "UTC"}) ════`);
    let meta: Map<string, AdInsight>;
    try {
      meta = await fetchMetaAdInsights(token, acct, { timeRange: { since, until }, campaignContains: cohort });
    } catch (e) { console.log(`  insights error: ${e instanceof Error ? e.message.slice(0, 120) : e}`); continue; }
    const rows = mergeDbFacts(meta, dbFacts).filter((r) => r.spend > 0).sort((a, b) => b.spend - a.spend);

    if (cohort) {
      // Leading-indicator funnel: the winner separates at ADD-TO-CART well before purchases land.
      console.log("  ad".padEnd(26), "spend impr  linkCTR clk  ATC  IC  P   clk→ATC");
      for (const r of rows) {
        const clkAtc = r.linkClicks > 0 ? `${(r.addToCart / r.linkClicks * 100).toFixed(0)}%` : "—";
        console.log(
          `  ${r.name.replace(/^MB (R1 · |Tabs · )?/, "").slice(0, 23).padEnd(24)}`,
          `$${r.spend.toFixed(0)}`.padStart(5), String(r.impressions).padStart(5),
          `${r.linkCtr.toFixed(2)}%`.padStart(7), String(r.linkClicks).padStart(3),
          String(r.addToCart).padStart(3), String(r.initiateCheckout).padStart(3), String(r.purchases).padStart(2), clkAtc.padStart(6),
        );
      }
      continue;
    }

    const buckets: Record<Verdict, AdInsight[]> = { winner: [], hold: [], kill: [], below_floor: [] };
    let totSpend = 0, totP = 0;
    for (const r of rows) {
      totSpend += r.spend; totP += r.purchases;
      const { verdict, fatigued, cpa, action } = classifyAd(r, t);
      buckets[verdict].push(r);
      const dest = r.destination === "lander" ? "L" : r.destination === "shopify_pdp" ? "S" : "?";
      console.log(`  ${icon(verdict)} $${r.spend.toFixed(0).padStart(5)} ${String(r.purchases).padStart(3)}p CPA ${(cpa == null ? "—" : `$${cpa.toFixed(0)}`).padStart(6)} f${r.frequency.toFixed(1)}${fatigued ? "⚠" : " "} [${dest}/${r.conversionSource[0]}] ${r.name.slice(0, 36).padEnd(36)} → ${action}`);
    }
    const blended = totP > 0 ? (totSpend / totP).toFixed(0) : "—";
    console.log(`  ── ${rows.length} ads · $${totSpend.toFixed(0)} spend · ${totP} purchases · blended CPA $${blended} ${totP > 0 && totSpend / totP > t.killCac ? "🔴 UNPROFITABLE" : ""}`);
    console.log(`  🟢${buckets.winner.length} winner · 🟡${buckets.hold.length} hold · 🔴${buckets.kill.length} kill · ⏳${buckets.below_floor.length} testing   ([L]ander/[S]hopify · conv src [m]eta/[d]b)`);
    if (buckets.kill.length) console.log(`  ▶ RETIRE: ${buckets.kill.map((r) => r.name.slice(0, 26)).join(" · ")}`);
    if (buckets.winner.length) console.log(`  ▶ SCALE: ${buckets.winner.map((r) => r.name.slice(0, 26)).join(" · ")}`);
  }
  console.log("\n(read-only — no ads changed. Purchases = canonical single field. Spend moves route through Max/CEO.)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
