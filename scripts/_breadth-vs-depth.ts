/**
 * "Keep every test adset at $150 and buy the spend ramp with MORE adsets instead of bigger ones."
 * (CEO 2026-08-25). Three things decide it:
 *
 *   1. Does CPA actually degrade as an adset's daily spend rises? If it's flat, breadth buys nothing
 *      and we should just run fewer/bigger. If it rises, breadth is right.
 *   2. How long does $150/day take to reach a 25-purchase verdict? That is the cost of the higher bar.
 *   3. Do we have the CREATIVE SUPPLY to fill that many concurrent slots? This is usually the binder.
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const $ = (c: number) => "$" + (c / 100).toFixed(0);
const PHASE1_DAILY_CENTS = Math.round((55000 / 30) * 100);

async function main() {
  const admin = createAdminClient();

  const rows: Array<{ meta_object_id: string; snapshot_date: string; spend_cents: number; purchases: number; revenue_cents: number; frequency: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("meta_insights_daily")
      .select("meta_object_id,snapshot_date,spend_cents,purchases,revenue_cents,frequency")
      .eq("workspace_id", WS).eq("level", "adset").gte("snapshot_date", "2026-06-01")
      .range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }

  // ── 1. CPA by DAILY SPEND BAND (adset-day grain) ─────────────────────────
  // Each adset-day is one observation: what did that adset spend that day, and what did it return?
  const BANDS: Array<[number, number, string]> = [
    [1, 7500, "< $75/day"],
    [7500, 12500, "$75–125"],
    [12500, 20000, "$125–200  ◄ the $150 test level"],
    [20000, 35000, "$200–350"],
    [35000, 70000, "$350–700"],
    [70000, 1e9, "> $700/day"],
  ];
  console.log("=== CPA vs an ADSET'S OWN DAILY SPEND (adset-day grain) ===");
  console.log("  band                          adset-days    spend    purch      CPA     ROAS   avg freq");
  for (const [lo, hi, label] of BANDS) {
    const inBand = rows.filter((r) => r.spend_cents >= lo && r.spend_cents < hi);
    if (!inBand.length) continue;
    const s = inBand.reduce((x, r) => x + r.spend_cents, 0);
    const p = inBand.reduce((x, r) => x + r.purchases, 0);
    const rev = inBand.reduce((x, r) => x + r.revenue_cents, 0);
    const fr = inBand.filter((r) => r.frequency > 0);
    const f = fr.length ? fr.reduce((x, r) => x + Number(r.frequency), 0) / fr.length : 0;
    console.log(
      `  ${label.padEnd(28)} ${String(inBand.length).padStart(8)} ${$(s).padStart(9)} ${String(p).padStart(7)}  ${(p ? $(s / p) : "—").padStart(8)}  ${(s ? (rev / s).toFixed(2) : "—").padStart(6)}   ${f ? f.toFixed(2) : "—"}`,
    );
  }
  console.log("\n  ⚠ Confounded: high-spend adset-days are mostly WINNERS that were scaled, so they");
  console.log("    carry the post-crown regression with them. Read the direction, not the magnitude.");

  // ── 2. Time to a 25-purchase verdict at $150/day ─────────────────────────
  console.log("\n=== TIME + COST TO A VERDICT AT $150/day ===");
  const testDays = rows.filter((r) => r.spend_cents >= 10000 && r.spend_cents < 20000);
  const tp = testDays.reduce((x, r) => x + r.purchases, 0);
  const ts = testDays.reduce((x, r) => x + r.spend_cents, 0);
  const perDay = tp / testDays.length;
  const cpa = tp ? ts / tp : 0;
  console.log(`  observed at the $100–200/day level: ${perDay.toFixed(2)} purchases/adset/day · CPA ${$(cpa)}`);
  for (const bar of [8, 15, 25, 40]) {
    const days = perDay > 0 ? bar / perDay : Infinity;
    console.log(`    to ${String(bar).padStart(2)} purchases → ${days.toFixed(0).padStart(3)} days · ${$(days * 15000)} spend per verdict`);
  }

  // ── 3. Creative supply ───────────────────────────────────────────────────
  console.log("\n=== CREATIVE SUPPLY — can we fill the slots? ===");
  const { data: ready } = await admin.from("ad_campaigns")
    .select("id,product_id,audience_temperature,concept_tag,status,max_qc_eligible,override_postable,landing_url")
    .eq("workspace_id", WS).neq("status", "archived");
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [p.id as string, String(p.title)]));

  // A creative is postable if it has a ready asset, a lander, and isn't Max-rejected.
  const { data: vids } = await admin.from("ad_videos").select("campaign_id,status,media_kind").eq("workspace_id", WS);
  const hasAsset = new Set((vids ?? []).filter((v) => v.status === "ready" || v.media_kind === "static").map((v) => String(v.campaign_id)));
  const { data: jobs } = await admin.from("ad_publish_jobs").select("campaign_id,status").eq("workspace_id", WS);
  const used = new Set((jobs ?? []).filter((j) => ["queued", "uploading", "creating", "published"].includes(String(j.status))).map((j) => String(j.campaign_id)));

  const avail = (ready ?? []).filter((c) =>
    hasAsset.has(String(c.id)) && !!c.landing_url && !used.has(String(c.id)) &&
    (c.max_qc_eligible !== false || c.override_postable === true));

  const byProdTemp: Record<string, number> = {};
  for (const c of avail) {
    const k = `${title.get(String(c.product_id)) ?? "(no product)"} · ${c.audience_temperature ?? "untagged"}`;
    byProdTemp[k] = (byProdTemp[k] ?? 0) + 1;
  }
  console.log(`  unposted, asset-ready, postable creatives: ${avail.length}`);
  for (const [k, v] of Object.entries(byProdTemp).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(46)} ${v}`);
  }
  const cold = avail.filter((c) => c.audience_temperature === "cold").length;
  console.log(`\n  COLD-tagged (the only band Bianca's replenish will use): ${cold}`);

  // ── the plan arithmetic ──────────────────────────────────────────────────
  const slots = Math.round(PHASE1_DAILY_CENTS / 15000);
  console.log(`\n=== THE BREADTH PLAN ===`);
  console.log(`  Phase 1 spend target        ${$(PHASE1_DAILY_CENTS)}/day`);
  console.log(`  at $150/adset               ${slots} concurrent test adsets`);
  console.log(`  cold creatives on hand      ${cold}   ${cold >= slots ? "✅ enough to fill" : `❌ SHORT BY ${slots - cold}`}`);
  console.log(`  verdicts/month at 25-purch  ${perDay > 0 ? (slots / (25 / perDay) * 30).toFixed(1) : "—"} (one per ${perDay > 0 ? (25 / perDay / slots * 30).toFixed(1) : "—"} days)`);
  console.log(`  learning-phase check        ${(perDay * 7).toFixed(1)} purchases/adset/week vs Meta's ~50/wk exit threshold`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
