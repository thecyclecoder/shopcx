/**
 * Seed a media-buyer test cohort for **Amazing Coffee K-Cups** (CEO 2026-08-24).
 *
 * ## Why
 *
 * Whole-bean Amazing Coffee is out of stock and its cohort is being disabled.
 * K-Cups are NOT out — ~3,900 units at the 3PL (~3,500 orders of headroom) —
 * but K-Cups had **no cohort at all**, so Bianca could never test it. This
 * creates one so the only coffee-adjacent product we can actually ship becomes
 * testable.
 *
 * ## How
 *
 * Goes through the sanctioned `provisionProductTestCohort` chokepoint rather
 * than hand-inserting: it find-or-creates the account's ABO testing campaign,
 * asserts replenishability before insert, and retires any prior active row for
 * the same (workspace, account, product).
 *
 * Every input is CLONED FROM THE SIBLING Creamer cohort in the same ad account
 * (`Amazing Coffee & Creamer`) so the page, pixel, IG identity and — critically
 * — the existing-customer exclusion audiences match what already works there.
 * Custom audiences are per-ad-account in Meta, so a sibling in the SAME account
 * is the only safe source.
 *
 * Targeting deliberately uses `DEFAULT_TEST_TARGETING` (US women 50-65) rather
 * than cloning Creamer's legacy 18-65 shape — that is the documented current
 * default per bianca-cold-test-audience-align-to-f50-65-converter.
 *
 * ## External calls
 *
 * Calls the META Graph API once (`getOrCreateTestingCampaign`) — it will find
 * the account's existing testing campaign, not create a new one. **No Appstle
 * calls** (Appstle bills per hit). **Creates no ad sets and spends nothing** —
 * per-test ad sets are only minted when Bianca fills a slot.
 *
 *   npx tsx scripts/_seed-kcups-test-cohort.ts            # dry run
 *   npx tsx scripts/_seed-kcups-test-cohort.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { provisionProductTestCohort, DEFAULT_TEST_TARGETING, maxConcurrentTests } from "../src/lib/media-buyer/provision-cohort";

const APPLY = process.argv.includes("--apply");
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET_TITLE = "Amazing Coffee K-Cups";
const SIBLING_TITLE = "Amazing Creamer"; // same ad account, known-good config

async function main() {
  const admin = createAdminClient();

  const { data: prods, error: pErr } = await admin
    .from("products").select("id,title").eq("workspace_id", WS)
    .in("title", [TARGET_TITLE, SIBLING_TITLE]);
  if (pErr) throw new Error(`products: ${pErr.message}`);
  const byTitle = new Map((prods ?? []).map((p) => [String(p.title), String(p.id)]));
  const productId = byTitle.get(TARGET_TITLE);
  const siblingId = byTitle.get(SIBLING_TITLE);
  if (!productId) throw new Error(`no product titled exactly "${TARGET_TITLE}"`);
  if (!siblingId) throw new Error(`no sibling product "${SIBLING_TITLE}" to clone config from`);

  const { data: sibling, error: sErr } = await admin
    .from("media_buyer_test_cohorts").select("*")
    .eq("workspace_id", WS).eq("product_id", siblingId).eq("is_active", true).maybeSingle();
  if (sErr) throw new Error(`sibling cohort: ${sErr.message}`);
  if (!sibling) throw new Error(`no ACTIVE ${SIBLING_TITLE} cohort to clone from`);

  const tpl = (sibling.adset_template ?? {}) as { pixelId?: string };
  const pixelId = String(tpl.pixelId ?? "");
  const metaAccountActId = String(sibling.default_meta_account_id ?? "");
  const pageId = String(sibling.default_meta_page_id ?? "");
  if (!pixelId || !metaAccountActId || !pageId) {
    throw new Error(`sibling cohort is missing pixelId/account/page — refusing to provision a broken row`);
  }

  const existing = await admin.from("media_buyer_test_cohorts")
    .select("id,is_active").eq("workspace_id", WS).eq("product_id", productId).maybeSingle();

  console.log(`=== SEED COHORT: ${TARGET_TITLE} ===\n`);
  console.log(`  product_id                 ${productId}`);
  console.log(`  cloning config from        ${SIBLING_TITLE} (${sibling.id})`);
  console.log(`  meta_ad_account (uuid)     ${sibling.meta_ad_account_id}`);
  console.log(`  meta act id                ${metaAccountActId}`);
  console.log(`  page / instagram           ${pageId} / ${sibling.default_meta_instagram_user_id ?? "—"}`);
  console.log(`  pixel                      ${pixelId}`);
  console.log(`  excluded purchaser aud     ${sibling.excluded_purchaser_audience_id ?? "— (none)"}`);
  console.log(`  excluded all-customers aud ${sibling.excluded_all_customers_audience_id ?? "— (none)"}`);
  console.log(`  ceiling / per-test         $${(Number(sibling.daily_test_ceiling_cents) / 100).toFixed(0)} / $${(Number(sibling.per_test_daily_budget_cents) / 100).toFixed(0)}`);
  console.log(`  max concurrent tests       ${maxConcurrentTests({ daily_test_ceiling_cents: Number(sibling.daily_test_ceiling_cents), per_test_daily_budget_cents: Number(sibling.per_test_daily_budget_cents) })}`);
  console.log(`  targeting                  DEFAULT_TEST_TARGETING → ${JSON.stringify(DEFAULT_TEST_TARGETING)}`);
  console.log(`  existing K-Cups cohort     ${existing.data ? `${existing.data.id} (active=${existing.data.is_active}) — will be retired + replaced` : "none"}`);

  if (!sibling.excluded_purchaser_audience_id || !sibling.excluded_all_customers_audience_id) {
    console.log("\n  ⚠ sibling carries no exclusion audience(s) — the new cohort would advertise");
    console.log("    the cold test at existing customers. Verify before applying.");
  }

  // Are there ready K-Cup creatives for Bianca to actually publish?
  const { count: readyCount } = await admin.from("ad_campaigns")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", WS).eq("product_id", productId).eq("status", "ready");
  console.log(`\n  ready-to-test K-Cup creatives: ${readyCount ?? 0}`);
  if (!readyCount) {
    console.log("  ⚠ the cohort will sit at 0/4 until Dahlia produces K-Cup creatives.");
    console.log("    Seeding the cohort is necessary but NOT sufficient to start testing.");
  }

  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write. (Will call Meta once to resolve the testing campaign.)"); return; }

  const res = await provisionProductTestCohort(admin, {
    workspaceId: WS,
    productId,
    metaAdAccountUuid: String(sibling.meta_ad_account_id),
    metaAccountActId,
    pageId,
    pixelId,
    instagramUserId: sibling.default_meta_instagram_user_id ? String(sibling.default_meta_instagram_user_id) : null,
    dailyTestCeilingCents: Number(sibling.daily_test_ceiling_cents),
    perTestDailyBudgetCents: Number(sibling.per_test_daily_budget_cents),
    excludedPurchaserAudienceId: sibling.excluded_purchaser_audience_id ? String(sibling.excluded_purchaser_audience_id) : null,
    excludedAllCustomersAudienceId: sibling.excluded_all_customers_audience_id ? String(sibling.excluded_all_customers_audience_id) : null,
    notes: `Amazing Coffee K-Cups per-test cohort — seeded 2026-08-24 (CEO). Whole-bean Coffee is out of stock; K-Cups has ~3,900 website units. Config cloned from the ${SIBLING_TITLE} sibling in the same ad account.`,
  });

  await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "media_buyer_cohort_seeded",
    spec_slug: null,
    reason:
      `Seeded a test cohort for ${TARGET_TITLE} (CEO 2026-08-24). Whole-bean Amazing Coffee is out of ` +
      `stock and disabled; K-Cups has ~3,900 website units and had NO cohort, so Bianca could never test it. ` +
      `Config cloned from the ${SIBLING_TITLE} sibling in the same ad account (page, pixel, IG, and both ` +
      `existing-customer exclusion audiences). Targeting uses the current F50-65 default, not Creamer's legacy 18-65.`,
    metadata: {
      cohort_id: res.cohortId,
      product_id: productId,
      product_title: TARGET_TITLE,
      cloned_from_cohort_id: sibling.id,
      test_meta_campaign_id: res.testMetaCampaignId,
      max_concurrent: res.maxConcurrent,
      ready_creatives_at_seed: readyCount ?? 0,
      autonomous: false,
    },
  });

  console.log(`\nAPPLIED. cohort ${res.cohortId}`);
  console.log(`  testing campaign ${res.testMetaCampaignId}   max concurrent tests ${res.maxConcurrent}`);
  console.log("  director_activity: media_buyer_cohort_seeded");
  console.log("  No ad sets created, no spend — Bianca mints those when it fills a slot.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(errText(e)); process.exit(1); });
