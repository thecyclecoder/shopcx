/**
 * Reproduce the replenish deficit for the Superfood Tabs cohort exactly as computeMediaBuyerPlan
 * does (src/lib/media-buyer/agent.ts § Winner-aware split + Replenish):
 *
 *   exploreTarget  = hasActiveWinner ? EXPLORE_TARGET_WITH_WINNER : cohortTargetCount
 *   exploreDeficit = max(0, exploreTarget - (liveCohortSize - liveExploitCount))
 *   ...then each candidate is REJECTED if its concept_tag is already live.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listAdSets } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_PRODUCT = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const TABS_TEST_CAMPAIGN = "120250066504550326";
const ID = "1319859a-d2d1-42e9-b125-fd6f00329a33";

async function main() {
  const admin = createAdminClient();

  // Crowned winners for this product — drives exploreTarget 4 → 2
  const { data: winners, error: ew } = await admin.from("media_buyer_crowned_winners")
    .select("*").eq("workspace_id", WS);
  if (ew) throw new Error(`crowned_winners: ${ew.message}`);
  console.log(`=== crowned winners (${(winners ?? []).length} total) ===`);
  for (const w of winners ?? []) {
    const keys = Object.keys(w).filter((k) => /product|adset|ad_id|exhaust|status|cpa|strike|created/i.test(k));
    console.log(`  ` + keys.map((k) => `${k}=${String(w[k]).slice(0, 30)}`).join(" · "));
  }

  // Live adsets in the Tabs TEST campaign + their source campaigns' concept tags
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");
  const adsets = await listAdSets(token, "196487894712827", TABS_TEST_CAMPAIGN);
  const live = adsets.filter((a) => a.effective_status === "ACTIVE");
  console.log(`\n=== live adsets in the Tabs TEST campaign ${TABS_TEST_CAMPAIGN} ===`);
  const crownedIds = new Set((winners ?? []).map((w) => String(w.test_meta_adset_id)));
  for (const a of adsets.filter((a) => a.effective_status === "ACTIVE")) {
    console.log(`  ● ${String(a.name).slice(0, 46).padEnd(46)} ${(a.daily_budget ? "$" + (Number(a.daily_budget) / 100).toFixed(0) : "—").padStart(7)}/day  id=${a.id}  ${crownedIds.has(String(a.id)) ? "◄ CROWNED WINNER" : "(not crowned)"}`);
  }
  console.log(`  live cohort size = ${live.length}`);

  // Which publish jobs minted those live adsets → their ad_campaigns → concept_tag
  const { data: jobs } = await admin.from("ad_publish_jobs")
    .select("campaign_id,meta_adset_id,origin,status").eq("workspace_id", WS)
    .in("meta_adset_id", live.map((a) => a.id));
  const campIds = [...new Set((jobs ?? []).map((j) => String(j.campaign_id)))];
  const { data: camps } = await admin.from("ad_campaigns")
    .select("id,name,concept_tag,audience_temperature").in("id", campIds.length ? campIds : ["00000000-0000-0000-0000-000000000000"]);

  console.log(`\n=== concept tags currently LIVE in the cohort ===`);
  const liveTags = new Set<string>();
  for (const c of camps ?? []) {
    if (c.concept_tag) liveTags.add(String(c.concept_tag));
    console.log(`  ${String(c.concept_tag ?? "(untagged)").padEnd(16)} ${String(c.name).slice(0, 50)}`);
  }
  console.log(`  liveTags = {${[...liveTags].join(", ")}}`);

  // The candidate
  const { data: cand } = await admin.from("ad_campaigns")
    .select("id,name,concept_tag,audience_temperature").eq("id", ID).maybeSingle();
  console.log(`\n=== the candidate ===`);
  console.log(`  ${cand?.name} · concept_tag=${cand?.concept_tag} · temp=${cand?.audience_temperature}`);

  // Reproduce the arithmetic
  const COHORT_TARGET = 4, EXPLORE_TARGET_WITH_WINNER = 2;
  const tabsWinners = (winners ?? []).filter((w) => {
    const s = JSON.stringify(w);
    return s.includes(TABS_PRODUCT) || s.includes(TABS_TEST_CAMPAIGN);
  });
  const hasWinner = tabsWinners.length > 0;
  const exploreTarget = hasWinner ? EXPLORE_TARGET_WITH_WINNER : COHORT_TARGET;

  console.log(`\n=== DEFICIT ARITHMETIC ===`);
  console.log(`  hasActiveWinner (Tabs)  ${hasWinner}  (${tabsWinners.length} matching winner rows)`);
  console.log(`  exploreTarget           ${exploreTarget}   ${hasWinner ? "(crowned ⇒ 2 explore + 2 exploit)" : "(pre-crown ⇒ full cohort target 4)"}`);
  console.log(`  live cohort size        ${live.length}`);
  console.log(`  exploreDeficit          max(0, ${exploreTarget} - liveExplore)`);
  for (const exploit of [0, 1, 2]) {
    const liveExplore = Math.max(0, live.length - exploit);
    console.log(`     if liveExploit=${exploit} → liveExplore=${liveExplore} → deficit = ${Math.max(0, exploreTarget - liveExplore)}`);
  }
  const tagBlocked = cand?.concept_tag ? liveTags.has(String(cand.concept_tag)) : false;
  console.log(`  concept-diversity block  ${tagBlocked ? `YES — '${cand?.concept_tag}' already live` : `no — '${cand?.concept_tag}' not in liveTags`}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
