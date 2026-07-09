// analyze-ad-tests — Max's read-only ad-test analysis lens. Pulls per-ad Meta insights
// for one or more ad accounts, computes LTV-derived CAC thresholds LIVE (never hardcoded),
// classifies every ad against the [[docs/brain/reference/meta-scaling-methodology]] ruleset
// (verdict floor · winner ≤ target · hold · kill · fatigue), and prints a verdict table +
// the recommended action per ad. This is the reasoning kernel behind the ads-analysis skill;
// it PROPOSES — a human/Max/CEO approves any spend move (north-star: tool proposes, owner disposes).
//
//   npx tsx scripts/analyze-ad-tests.ts <accountId> [<accountId> ...] [--ltv=424] [--days=30]
//   (default accounts = Amazing Coffee 2352876514967984, Superfood Tabs 196487894712827)
//
// READ-ONLY: no writes, no ad mutations. Retire/promote decisions are surfaced, not executed.
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { metaGraphRequest } from "../src/lib/meta/api";
import { getMonthlyChurn, blendedLifetimeOrders } from "../src/lib/ltv";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

// Ratio setpoints ARE the strategy (config); the dollar thresholds are DERIVED from live LTV.
const TARGET_CAC_LTV = 3; // target CAC = LTV / 3  (DEFAULT_BLENDED_CAC_LTV_TARGET)
const KILL_CAC_LTV = 1.5; // kill CAC   = LTV / 1.5 (breakeven-ish floor)
const VERDICT_FLOOR_SPEND = 450; // ≈3× our CPA — no verdict under this spend (anti-fluke)
const MIN_PURCHASES = 3; // reject 1-order flukes
const DOCUMENTED_LTV_FALLBACK = 424; // 2026-07-07 snapshot; used only if live data is thin
const FATIGUE_FREQ_ACT = 4.5; // act on frequency at/above this (Andromeda: freq hides fatigue — co-equal only)

interface AdRow { ad: string; camp: string; spend: number; p: number; cpa: number | null; freq: number; ctr: number; }
type Verdict = "winner" | "hold" | "kill" | "below_floor";

function purchases(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  const p = (actions as Array<{ action_type: string; value: string }>).find(
    (a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase",
  );
  return p ? Number(p.value) : 0;
}

/** Live LTV = AOV × blended lifetime orders, from the latest COMPLETE monthly_revenue_snapshot.
 *  Falls back to the documented figure only when snapshots are missing/thin (labelled in output). */
async function liveLtv(admin: ReturnType<typeof createAdminClient>): Promise<{ ltv: number; basis: string }> {
  try {
    const churn = await getMonthlyChurn({ admin, workspaceId: WS, trailingMonths: null }); // all-history = ROAS parity
    const { data } = await admin
      .from("monthly_revenue_snapshots")
      .select("subscription_rate, total_revenue_cents, total_count, month")
      .eq("workspace_id", WS)
      .eq("is_complete", true)
      .order("month", { ascending: false })
      .limit(1);
    const s = (data || [])[0] as { subscription_rate: number; total_revenue_cents: number; total_count: number; month: string } | undefined;
    if (s && s.total_count > 0 && churn.monthly_churn > 0) {
      const subRate = Number(s.subscription_rate) / 100;
      const aov = s.total_revenue_cents / 100 / s.total_count;
      const ltv = aov * blendedLifetimeOrders(subRate, churn.monthly_churn);
      return { ltv, basis: `live: AOV $${aov.toFixed(0)} × ${blendedLifetimeOrders(subRate, churn.monthly_churn).toFixed(1)} orders (sub ${(subRate * 100).toFixed(0)}%, churn ${(churn.monthly_churn * 100).toFixed(1)}%, ${s.month})` };
    }
  } catch (e) {
    console.error("  (live LTV failed, using documented fallback):", e instanceof Error ? e.message : e);
  }
  return { ltv: DOCUMENTED_LTV_FALLBACK, basis: `documented fallback $${DOCUMENTED_LTV_FALLBACK} (live snapshot thin)` };
}

function classify(r: AdRow, targetCac: number, killCac: number): { verdict: Verdict; fatigued: boolean; action: string } {
  const fatigued = r.freq >= FATIGUE_FREQ_ACT && r.ctr < 1.0; // freq high AND CTR weak (co-equal, never freq alone)
  if (r.spend < VERDICT_FLOOR_SPEND) return { verdict: "below_floor", fatigued, action: "keep running — below $450 verdict floor, no decision yet" };
  if (r.cpa == null || r.p < MIN_PURCHASES) return { verdict: "kill", fatigued, action: `KILL — ${r.p} purchase(s) at $${r.spend.toFixed(0)} (no/flukey conversion at spend)` };
  if (r.cpa <= targetCac) return { verdict: "winner", fatigued, action: fatigued ? "WINNER but FATIGUED — promote a fresh cut / refresh creative before scaling" : "WINNER — duplicate into the scaler (Advantage+/CBO), +20% max per 3–4d while ROAS holds" };
  if (r.cpa <= killCac) return { verdict: "hold", fatigued, action: fatigued ? "HOLD + FATIGUED — refresh; do not scale a tiring creative" : "HOLD — above target but under kill; iterate hook/creative, don't scale" };
  return { verdict: "kill", fatigued, action: `KILL — CPA $${r.cpa.toFixed(0)} > kill line $${killCac.toFixed(0)}` };
}

async function main() {
  const args = process.argv.slice(2);
  const ltvOverride = args.find((a) => a.startsWith("--ltv="))?.split("=")[1];
  const days = args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "30";
  const preset = `last_${days}d`;
  const accounts = args.filter((a) => !a.startsWith("--"));
  const ACCOUNTS = accounts.length ? accounts : ["2352876514967984", "196487894712827"];

  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) { console.error("NO META TOKEN for workspace"); process.exit(1); }

  const { ltv, basis } = ltvOverride ? { ltv: Number(ltvOverride), basis: `override $${ltvOverride}` } : await liveLtv(admin);
  const targetCac = ltv / TARGET_CAC_LTV;
  const killCac = ltv / KILL_CAC_LTV;
  console.log(`LTV $${ltv.toFixed(0)} (${basis})  →  target CAC $${targetCac.toFixed(0)} (LTV/${TARGET_CAC_LTV})  ·  kill CAC $${killCac.toFixed(0)} (LTV/${KILL_CAC_LTV})  ·  window ${preset}`);

  for (const acct of ACCOUNTS) {
    console.log(`\n════ act_${acct} ════`);
    const ins = (await metaGraphRequest(token, `/act_${acct}/insights`, {
      level: "ad",
      fields: "ad_name,campaign_name,spend,actions,frequency,ctr",
      date_preset: preset,
      limit: "300",
    }).catch((e) => ({ error: String(e).slice(0, 140) }))) as { data?: unknown[]; error?: string };
    if (ins.error) { console.log(`  insights error: ${ins.error}`); continue; }
    const rows: AdRow[] = (ins.data || []).map((raw) => {
      const r = raw as Record<string, unknown>;
      const spend = Number(r.spend || 0);
      const p = purchases(r.actions);
      return { ad: String(r.ad_name || ""), camp: String(r.campaign_name || ""), spend, p, cpa: p > 0 ? spend / p : null, freq: Number(r.frequency || 0), ctr: Number(r.ctr || 0) };
    }).filter((r) => r.spend > 0).sort((a, b) => b.spend - a.spend);

    const buckets: Record<Verdict, AdRow[]> = { winner: [], hold: [], kill: [], below_floor: [] };
    let totSpend = 0, totP = 0;
    for (const r of rows) {
      totSpend += r.spend; totP += r.p;
      const { verdict, fatigued, action } = classify(r, targetCac, killCac);
      buckets[verdict].push(r);
      const icon = verdict === "winner" ? "🟢" : verdict === "hold" ? "🟡" : verdict === "kill" ? "🔴" : "⏳";
      const cpaStr = r.cpa == null ? "  —  " : `$${r.cpa.toFixed(0)}`;
      console.log(`  ${icon} $${r.spend.toFixed(0).padStart(5)} ${String(r.p).padStart(3)}p CPA ${cpaStr.padStart(6)} f${r.freq.toFixed(1)}${fatigued ? "⚠" : " "} ctr${r.ctr.toFixed(2)}  ${(r.ad).slice(0, 40).padEnd(40)}  → ${action}`);
    }
    const blended = totP > 0 ? (totSpend / totP).toFixed(0) : "—";
    console.log(`  ── ${rows.length} ads · $${totSpend.toFixed(0)} spend · ${totP} purchases · blended CPA $${blended} ${totP > 0 && totSpend / totP > killCac ? "🔴 ACCOUNT UNPROFITABLE (blended>kill)" : ""}`);
    console.log(`  verdicts: 🟢${buckets.winner.length} winner · 🟡${buckets.hold.length} hold · 🔴${buckets.kill.length} kill · ⏳${buckets.below_floor.length} still testing`);
    if (buckets.kill.length) console.log(`  ▶ RETIRE now: ${buckets.kill.map((r) => r.ad.slice(0, 28)).join(" · ")}`);
    if (buckets.winner.length) console.log(`  ▶ PROMOTE/scale: ${buckets.winner.map((r) => r.ad.slice(0, 28)).join(" · ")}`);
  }
  console.log("\n(read-only — no ads were changed. Spend moves route through Max/CEO approval.)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
