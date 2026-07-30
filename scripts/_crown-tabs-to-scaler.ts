/**
 * Crown the two Superfood Tabs winners into a new cold-scaler campaign (CEO 2026-07-27).
 *
 * Both ads hit 8 purchases at just over Bianca's $150 crown CPA, so she will not graduate
 * them herself. The CEO is overriding that gate. Structure mirrors the ONLY existing scaler
 * (Ashwavana Zen Relax, campaign 120249609991450682): a CBO OUTCOME_SALES / Advantage+ Sales
 * campaign at $300/day, ONE "crowned winners" adset, both ads re-created inside it against
 * their existing test creative_ids.
 *
 *   Winners (meta_insights_daily, level='ad', lifetime):
 *     120250143054820326  MB Tabs · skeptic-bloat            $1,372  8 purch  $171 CPA
 *     120250419137920326  Dahlia · Feel Lighter Every Day    $1,323  8 purch  $165 CPA
 *
 * Their two test adsets (the only ACTIVE ones in the test campaign) are paused at the end,
 * so spend hands over rather than doubling.
 *
 * No bid limit: the adset uses `LOWEST_COST_WITHOUT_CAP` (the Tabs cohort template's own
 * bidStrategy) — Meta auto-bid, no cap.
 *
 *   npx tsx scripts/_crown-tabs-to-scaler.ts            # dry run
 *   npx tsx scripts/_crown-tabs-to-scaler.ts --apply
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCT_ID = "221d272d-a6c5-4a5d-86ff-ac693926c992"; // Superfood Tabs
const ACCT_UUID = "2a97bb87-9806-472f-a4a7-f6f6125dd9bf";
const ACCT_META = "196487894712827";
const DAILY_CEILING_CENTS = 30000; // $300/day — matches Zen Relax + the $300/day the 2 tests were burning

const WINNERS = [
  { adId: "120250143054820326", adsetId: "120250143054030326", creativeId: "1750330862815195", name: "MB Tabs · skeptic-bloat" },
  { adId: "120250419137920326", adsetId: "120250419137310326", creativeId: "2288453908583220", name: "Dahlia · Superfood Tabs · Feel Lighter Every Single Day" },
];

const PIXEL_ID = "468487900426092";
const TARGETING = {
  age_min: 18, age_max: 65,
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
  excluded_custom_audiences: [{ id: "120250451196720326" }, { id: "120250451207710326" }],
};

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  // ── Preconditions ────────────────────────────────────────────────────
  const { data: existingCohort } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id, scaler_meta_campaign_id, is_active")
    .eq("workspace_id", W).eq("product_id", PRODUCT_ID).maybeSingle();
  console.log("Existing Tabs scaler cohort:", JSON.stringify(existingCohort ?? null));
  if (existingCohort?.scaler_meta_campaign_id) {
    console.log("  ⚠ a scaler campaign already exists for Superfood Tabs — aborting rather than minting a second.");
    process.exit(1);
  }

  const { data: liveAds } = await admin.from("meta_ads")
    .select("meta_ad_id, name, creative_id, effective_status")
    .eq("workspace_id", W).in("meta_ad_id", WINNERS.map(w => w.adId));
  console.log("Winner ads:", JSON.stringify(liveAds));
  for (const w of WINNERS) {
    const hit = (liveAds || []).find((a: any) => a.meta_ad_id === w.adId);
    if (!hit) { console.log(`  ⚠ ${w.adId} not found — aborting`); process.exit(1); }
    if (hit.creative_id !== w.creativeId) { console.log(`  ⚠ ${w.adId} creative drifted (${hit.creative_id} ≠ ${w.creativeId}) — aborting`); process.exit(1); }
  }

  if (!APPLY) {
    console.log("\nWould do:");
    console.log(`  1. seed media_buyer_cold_scaler_cohorts (product=Superfood Tabs, acct=${ACCT_META}, $${DAILY_CEILING_CENTS / 100}/day)`);
    console.log("  2. mint CBO OUTCOME_SALES / Advantage+ Sales scaler campaign (new-customer-only), then ACTIVATE");
    console.log("  3. create adset 'Scale · Superfood Tabs · crowned winners (POST ID)' — PURCHASE opt, LOWEST_COST_WITHOUT_CAP (no bid limit), ACTIVE");
    console.log("  4. create both winner ads inside it (reusing their creative ids), ACTIVE");
    console.log(`  5. PAUSE the 2 test adsets: ${WINNERS.map(w => w.adsetId).join(", ")}`);
    console.log("\nRe-run with --apply.");
    return;
  }

  const { getMetaUserToken, getOrCreateColdScalerCampaign, createAdSet, createAd, updateObjectStatus } = await import("../src/lib/meta-ads");
  const { setColdScalerCampaignId } = await import("../src/lib/media-buyer/cold-scaler-cohort");
  const token = await getMetaUserToken(W);
  if (!token) throw new Error("no meta user token");

  // 1. Cohort row (mirrors the CEO-seeded Zen Relax row).
  let cohortId = existingCohort?.id as string | undefined;
  if (!cohortId) {
    const { data: ins, error } = await admin.from("media_buyer_cold_scaler_cohorts").insert({
      workspace_id: W, meta_ad_account_id: ACCT_UUID, product_id: PRODUCT_ID,
      daily_scaler_ceiling_cents: DAILY_CEILING_CENTS, is_active: true,
      notes: "CEO-seeded 2026-07-27 — first Superfood Tabs crown: skeptic-bloat ($171 CPA) + Feel Lighter Every Single Day ($165 CPA), 8 purchases each. Above Bianca's $150 crown CPA so the CEO graduated them manually. $300/day CBO scaler.",
    }).select("id").single();
    if (error) throw error;
    cohortId = ins.id;
    console.log("  ✓ cohort seeded:", cohortId);
  }

  // 2. Campaign — minted PAUSED by the SDK, then explicitly activated.
  const campaignId = await getOrCreateColdScalerCampaign(token, ACCT_META, {
    cohortId: cohortId!,
    dailyCeilingCents: DAILY_CEILING_CENTS,
    name: `MB — Superfood Tabs - Cold Scaler (${cohortId!.slice(0, 8)})`,
  });
  console.log("  ✓ scaler campaign:", campaignId);
  const stamp = await setColdScalerCampaignId(admin, { cohortId: cohortId!, scalerMetaCampaignId: campaignId });
  console.log(`  ✓ campaign id stamped on cohort (rows=${stamp.stamped})`);
  await updateObjectStatus(token, campaignId, "ACTIVE");
  console.log("  ✓ campaign ACTIVE");

  // 3. One CBO adset (no adset budget — campaign carries it). No bid cap.
  const adsetId = await createAdSet(token, ACCT_META, {
    name: "Scale · Superfood Tabs · crowned winners (POST ID)",
    campaignId,
    pixelId: PIXEL_ID,
    customEventType: "PURCHASE",
    targeting: TARGETING,
    optimizationGoal: "OFFSITE_CONVERSIONS",
    billingEvent: "IMPRESSIONS",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP", // no bid limit
    status: "ACTIVE",
  });
  console.log("  ✓ adset:", adsetId);

  // 4. Both winners into the scaler adset.
  const created: string[] = [];
  for (const w of WINNERS) {
    const id = await createAd(token, ACCT_META, {
      name: `${w.name} - Copy`, adsetId, creativeId: w.creativeId, status: "ACTIVE",
    });
    created.push(id);
    console.log(`  ✓ ad ${id} ← creative ${w.creativeId} (${w.name})`);
  }

  // 5. Pause the two test adsets so spend hands over instead of doubling.
  for (const w of WINNERS) {
    await updateObjectStatus(token, w.adsetId, "PAUSED");
    console.log(`  ✓ test adset ${w.adsetId} PAUSED`);
  }

  console.log("\n=== DONE ===");
  console.log(`cohort=${cohortId} campaign=${campaignId} adset=${adsetId} ads=${created.join(",")}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
