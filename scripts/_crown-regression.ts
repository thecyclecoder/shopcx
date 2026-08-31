/**
 * Is the post-crown degradation REGRESSION TO THE MEAN rather than a scale-campaign artifact?
 *
 * CEO question (2026-08-25): "ads do well in test, worse when duplicated to scale — so should we
 * just scale the test adset in place?" We already scale in place (the graduate never ran), so this
 * measures whether in-place scaling ALSO degrades. If it does, the scale campaign is not the cause.
 *
 * Also puts a number on the crown threshold's noise floor: `crown_min_purchases = 8`. A CPA measured
 * on 8 purchases has a Poisson relative SE of 1/sqrt(8) = 35%, so the 95% interval spans ~0.5x-2.0x.
 * Selecting best-of-N on that is selecting substantially on noise, and the winner MUST regress
 * wherever you run it next.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();

  const { data: winners, error } = await admin.from("media_buyer_crowned_winners")
    .select("test_meta_adset_id,winning_meta_ad_id,product_id,created_at").eq("workspace_id", WS);
  if (error) throw new Error(error.message);

  const rows: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error: e } = await admin.from("meta_insights_daily")
      .select("meta_object_id,snapshot_date,spend_cents,purchases,revenue_cents")
      .eq("workspace_id", WS).eq("level", "adset").gte("snapshot_date", "2026-06-01")
      .range(off, off + 999);
    if (e) throw new Error(e.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }

  console.log("=== EVERY CROWNED WINNER: performance BEFORE vs AFTER its crown ===");
  console.log("   (all of these were scaled IN PLACE — the automated graduate never ran)\n");
  console.log("  adset         crowned         PRE-crown                POST-crown             change");

  let preS = 0, preP = 0, postS = 0, postP = 0;
  for (const w of winners ?? []) {
    const id = String(w.test_meta_adset_id);
    const crownDay = String(w.created_at).slice(0, 10);
    const mine = rows.filter((r) => String(r.meta_object_id) === id);
    const agg = (f: (d: string) => boolean) => {
      let s = 0, p = 0;
      for (const r of mine) if (f(String(r.snapshot_date))) { s += Number(r.spend_cents ?? 0); p += Number(r.purchases ?? 0); }
      return { s, p };
    };
    const pre = agg((d) => d < crownDay);
    const post = agg((d) => d >= crownDay);
    preS += pre.s; preP += pre.p; postS += post.s; postP += post.p;

    const preCpa = pre.p ? pre.s / pre.p : null;
    const postCpa = post.p ? post.s / post.p : null;
    const chg = preCpa && postCpa ? `${(postCpa / preCpa - 1) * 100 >= 0 ? "+" : ""}${((postCpa / preCpa - 1) * 100).toFixed(0)}%` : "—";
    console.log(
      `  ${id.slice(-10)}  ${crownDay}   ${$(pre.s).padStart(7)} ${String(pre.p).padStart(3)}p ${(preCpa ? "CPA " + $(preCpa) : "—").padStart(11)}   ` +
      `${$(post.s).padStart(7)} ${String(post.p).padStart(3)}p ${(postCpa ? "CPA " + $(postCpa) : "no purch").padStart(11)}  ${chg.padStart(7)}`,
    );
  }

  const preCpaAll = preP ? preS / preP : 0, postCpaAll = postP ? postS / postP : 0;
  console.log(`\n  ── POOLED ──`);
  console.log(`  pre-crown   ${$(preS)} · ${preP} purchases · CPA ${$(preCpaAll)}`);
  console.log(`  post-crown  ${$(postS)} · ${postP} purchases · CPA ${postP ? $(postCpaAll) : "n/a"}`);
  if (preP && postP) {
    console.log(`  ► post-crown CPA is ${(postCpaAll / preCpaAll).toFixed(2)}x the pre-crown CPA — scaled IN PLACE, no scale campaign involved.`);
  }

  console.log(`\n=== WHAT n=8 PURCHASES CAN ACTUALLY TELL YOU ===`);
  console.log(`  crown_min_purchases = 8 · crown_max_cpa = $240 · crown_min_spend = $450\n`);
  console.log(`   n     rel. SE    95% CI on a measured $220 CPA     separates $220 from a $400 dud?`);
  for (const n of [3, 8, 15, 25, 40, 60]) {
    const se = 1 / Math.sqrt(n);
    const lo = 220 * Math.exp(-1.96 * se), hi = 220 * Math.exp(1.96 * se);
    console.log(`  ${String(n).padStart(3)}    ${(100 * se).toFixed(0).padStart(5)}%    $${lo.toFixed(0).padStart(4)} – $${hi.toFixed(0).padStart(5)}${" ".repeat(15)}${hi < 400 ? "YES" : "no — $400 sits inside the interval"}`);
  }
  console.log(`\n  At n=8 a "winner" at $220 cannot be told apart from a $400 dud.`);
  console.log(`  Best-of-N selection on that sample picks the LUCKIEST adset, not the best one —`);
  console.log(`  and luck does not replicate, in a scale campaign OR scaled in place.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
