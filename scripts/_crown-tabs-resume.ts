/**
 * Resume the Superfood Tabs crown after `getOrCreateColdScalerCampaign` failed.
 *
 * Meta rejected the mint with:
 *   (#100) Invalid campaign param(daily_budget) to create an ASC ad
 * An Advantage+ Sales (`smart_promotion_type=AUTOMATED_SHOPPING_ADS`) campaign will not
 * accept a campaign-level `daily_budget` in the CREATE call — it has to be POSTed after.
 * `getOrCreateColdScalerCampaign` always inlines it, so the SDK path cannot mint an ASC
 * scaler today (Bianca's graduate flow would hit the same wall).
 *
 * Cohort 0e66ff03 was already seeded by the first run. This resumes from there:
 * create → set budget → activate → adset → both ads → pause the test adsets.
 *
 *   npx tsx scripts/_crown-tabs-resume.ts            # dry run
 *   npx tsx scripts/_crown-tabs-resume.ts --apply
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COHORT_ID = "0e66ff03-22c4-4910-b239-9d90ede625ce";
const ACCT_META = "196487894712827";
const DAILY_CEILING_CENTS = 30000;
const CAMPAIGN_NAME = `MB — Superfood Tabs - Cold Scaler (${COHORT_ID.slice(0, 8)})`;

const WINNERS = [
  { adsetId: "120250143054030326", creativeId: "1750330862815195", name: "MB Tabs · skeptic-bloat" },
  { adsetId: "120250419137310326", creativeId: "2288453908583220", name: "Dahlia · Superfood Tabs · Feel Lighter Every Single Day" },
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

  const { data: cohort } = await admin.from("media_buyer_cold_scaler_cohorts")
    .select("id, scaler_meta_campaign_id, daily_scaler_ceiling_cents, is_active")
    .eq("id", COHORT_ID).maybeSingle();
  if (!cohort) throw new Error("cohort missing — re-run the seed step");
  console.log("Cohort:", JSON.stringify(cohort));

  const { getMetaUserToken, listCampaigns, createCampaign, updateObjectBudget, createAdSet, createAd, updateObjectStatus } = await import("../src/lib/meta-ads");
  const { setColdScalerCampaignId } = await import("../src/lib/media-buyer/cold-scaler-cohort");
  const token = await getMetaUserToken(W);
  if (!token) throw new Error("no meta user token");

  // Idempotency: never mint a second campaign with this name.
  const existing = (await listCampaigns(token, ACCT_META)).find(c => c.name === CAMPAIGN_NAME);
  console.log("Existing campaign by name:", existing ? `${existing.id} [${(existing as any).status}]` : "none");

  if (!APPLY) {
    console.log("\nWould:");
    console.log(existing ? `  reuse campaign ${existing.id}` : "  createCampaign (ASC, CBO, NO daily_budget in the create body)");
    console.log(`  then POST daily_budget=${DAILY_CEILING_CENTS} separately, activate, build adset + 2 ads, pause 2 test adsets`);
    return;
  }

  let campaignId = cohort.scaler_meta_campaign_id || existing?.id;
  if (!campaignId) {
    // Meta v24.0+ REFUSES to create an ASC campaign at all:
    //   "ASC campaigns no longer supported ... with v24.0 and beyond" (code 100/2490568)
    // So this is a STANDARD CBO OUTCOME_SALES campaign — no `smart_promotion_type`, and no
    // `existing_customer_budget_percentage` (an ASC-only knob). New-customer-only is enforced
    // at the adset instead, via the cohort template's `excluded_custom_audiences`
    // (the all-customers audiences), which is where it already lives for the test rail.
    campaignId = await createCampaign(token, ACCT_META, {
      name: CAMPAIGN_NAME,
      objective: "OUTCOME_SALES",
      abo: false,
      dailyBudgetCents: DAILY_CEILING_CENTS,
      status: "PAUSED",
    });
    console.log("  ✓ campaign created:", campaignId);
  } else {
    console.log("  · reusing campaign:", campaignId);
  }

  if (!cohort.scaler_meta_campaign_id) {
    const stamp = await setColdScalerCampaignId(admin, { cohortId: COHORT_ID, scalerMetaCampaignId: campaignId });
    console.log(`  ✓ stamped on cohort (rows=${stamp.stamped})`);
  }

  await updateObjectBudget(token, campaignId, { dailyBudgetCents: DAILY_CEILING_CENTS });
  console.log(`  ✓ campaign daily_budget set to $${DAILY_CEILING_CENTS / 100}`);

  await updateObjectStatus(token, campaignId, "ACTIVE");
  console.log("  ✓ campaign ACTIVE");

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

  const created: string[] = [];
  for (const w of WINNERS) {
    const id = await createAd(token, ACCT_META, { name: `${w.name} - Copy`, adsetId, creativeId: w.creativeId, status: "ACTIVE" });
    created.push(id);
    console.log(`  ✓ ad ${id} ← creative ${w.creativeId} (${w.name})`);
  }

  for (const w of WINNERS) {
    await updateObjectStatus(token, w.adsetId, "PAUSED");
    console.log(`  ✓ test adset ${w.adsetId} PAUSED`);
  }

  console.log("\n=== DONE ===");
  console.log(`cohort=${COHORT_ID} campaign=${campaignId} adset=${adsetId} ads=${created.join(",")}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
