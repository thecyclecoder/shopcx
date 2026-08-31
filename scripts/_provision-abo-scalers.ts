/**
 * CEO 2026-08-25 — stand up a proper ABO cold-scaler campaign per product, in the RIGHT ad account.
 *
 * Why ABO: a CBO / Advantage+ scaler hands ALLOCATION to Meta. The CEO moved crowned winners into
 * one and Meta put ~95% of spend behind a single ad — the portfolio of proven creatives never got
 * funded, and the one ad Meta picked saturated its best audience. Per-adset budgets keep allocation
 * ours: each graduated winner keeps its own funding.
 *
 * Per product: resolve its ad account FROM ITS TEST COHORT (never guessed), find-or-mint
 * `MB — {Product} Scaler (ABO)` PAUSED via the meta-ads SDK, provision the cold-scaler cohort row
 * through the sanctioned writer, and compare-and-set stamp the campaign id.
 *
 * Every campaign is minted PAUSED — there are 0 qualifying crowned winners today, so nothing should
 * be delivering. Amazing Coffee stays paused permanently (out of stock, CEO).
 *
 * Also retires the two legacy CBO scalers: pauses any that is ACTIVE (an empty CBO campaign with a
 * live budget is a loaded gun) and leaves them in place as history.
 *
 * IDEMPOTENT — find-or-create by exact name, compare-and-set stamp. Pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, getOrCreateColdScalerCampaign, coldScalerCampaignName, listCampaigns, updateObjectStatus } from "../src/lib/meta-ads";
import { provisionColdScalerCohort, setColdScalerCampaignId } from "../src/lib/media-buyer/cold-scaler-cohort";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

/** Governance ceiling per cohort. NOT a campaign budget on ABO — the graduate sizes ad sets against it. */
const DEFAULT_CEILING_CENTS = 30000; // $300/day, matching the two pre-existing cohorts

/** Product titles the CEO named, in order. Resolved to ids + accounts from the DB, never hardcoded. */
const PRODUCTS = [
  "Superfood Tabs",
  "Amazing Coffee K-Cups",
  "Amazing Creamer",
  "Amazing Coffee", // stays PAUSED permanently — out of stock
  "Ashwavana Zen Relax",
  "Ashwavana Guru Focus",
  "Creatine Prime+",
];

/** Legacy CBO scalers to retire. */
const LEGACY_CBO = ["120249609991450682", "120250620926360326"];

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no active Meta token");

  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name").eq("workspace_id", WS);
  const { data: testCohorts } = await admin.from("media_buyer_test_cohorts")
    .select("product_id,meta_ad_account_id").eq("workspace_id", WS);

  const acct = new Map((accts ?? []).map((a) => [String(a.id), a]));
  const results: Array<Record<string, unknown>> = [];

  for (const title of PRODUCTS) {
    const p = (prods ?? []).find((x) => String(x.title).toLowerCase() === title.toLowerCase());
    if (!p) { console.log(`❌ ${title} — no product row; SKIPPING`); continue; }

    // The ad account comes from the product's OWN test cohort — never inferred from the name.
    const tc = (testCohorts ?? []).find((c) => c.product_id === p.id);
    if (!tc?.meta_ad_account_id) { console.log(`❌ ${title} — no test cohort ⇒ ad account unknown; SKIPPING`); continue; }
    const a = acct.get(String(tc.meta_ad_account_id));
    if (!a) { console.log(`❌ ${title} — ad account row missing; SKIPPING`); continue; }

    console.log(`\n${title}`);
    console.log(`   account  ${a.meta_account_name} (act_${a.meta_account_id})`);

    if (!APPLY) {
      console.log(`   would mint  "${coldScalerCampaignName("00000000", p.title)}"  PAUSED, ABO, ceiling $${DEFAULT_CEILING_CENTS / 100}/day`);
      continue;
    }

    // 1. cohort row (sanctioned writer — retires any prior active row for the scope)
    const cohort = await provisionColdScalerCohort(admin, {
      workspaceId: WS,
      metaAdAccountId: String(a.id),
      productId: String(p.id),
      dailyScalerCeilingCents: DEFAULT_CEILING_CENTS,
      notes: `ABO cold scaler for ${p.title} (CEO 2026-08-25 — ABO so Meta cannot concentrate spend on one ad).`,
    });

    // 2. find-or-mint the ABO campaign in THIS account
    const campaignId = await getOrCreateColdScalerCampaign(token, String(a.meta_account_id), {
      cohortId: cohort.cohortId,
      dailyCeilingCents: DEFAULT_CEILING_CENTS, // governance only — not a campaign budget on ABO
      productTitle: p.title,
    });

    // 3. stamp it (compare-and-set)
    await setColdScalerCampaignId(admin, { cohortId: cohort.cohortId, scalerMetaCampaignId: campaignId });

    console.log(`   ✅ campaign ${campaignId}  "${coldScalerCampaignName(cohort.cohortId, p.title)}"  cohort ${cohort.cohortId.slice(0, 8)}`);
    results.push({ product: p.title, product_id: p.id, account: a.meta_account_name, campaign_id: campaignId, cohort_id: cohort.cohortId });
  }

  // ── retire the legacy CBO scalers ────────────────────────────────────────
  console.log(`\n=== LEGACY CBO SCALERS ===`);
  for (const a of accts ?? []) {
    let camps;
    try { camps = await listCampaigns(token, String(a.meta_account_id)); } catch { continue; }
    for (const c of camps.filter((x) => LEGACY_CBO.includes(x.id))) {
      const live = c.effective_status === "ACTIVE";
      console.log(`  ${c.name}  ${c.effective_status}  ${c.daily_budget ? `CBO $${(Number(c.daily_budget) / 100).toFixed(0)}/day` : ""}`);
      if (!live) { console.log(`     already paused — leaving as history`); continue; }
      if (!APPLY) { console.log(`     would PAUSE (empty CBO campaign with a live budget)`); continue; }
      await updateObjectStatus(token, c.id, "PAUSED");
      console.log(`     ✅ paused`);
    }
  }

  if (APPLY && results.length) {
    const { error } = await admin.from("director_activity").insert({
      workspace_id: WS,
      director_function: "growth",
      action_kind: "media_buyer_abo_scalers_provisioned",
      reason:
        `CEO 2026-08-25: provisioned ${results.length} ABO cold-scaler campaigns (one per product, each in its own ` +
        `ad account resolved from the product's test cohort), all PAUSED. ABO not CBO: a CBO/Advantage+ scaler hands ` +
        `allocation to Meta — crowned winners graduated into one and ~95% of spend went behind a single ad, so the ` +
        `portfolio never got funded. Per-adset budgets keep allocation ours. Legacy CBO scalers paused + retired. ` +
        `Amazing Coffee stays paused permanently (out of stock).`,
      metadata: { scalers: results, ceiling_cents: DEFAULT_CEILING_CENTS, retired_cbo: LEGACY_CBO, autonomous: false },
    });
    if (error) console.log(`\n⚠ audit row failed: ${error.message}`);
    else console.log(`\n✅ director_activity audit row written`);
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (pass --apply)"}: ${results.length} scaler(s)`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
