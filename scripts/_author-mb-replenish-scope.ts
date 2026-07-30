import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "media-buyer-replenish-per-product-scope",
    {
      title: "Media-buyer replenish: scope the deficit, bin, and publish to the product's own test cohort",
      why: "Bianca never tops up a product's tests: the replenish deficit compares a WORKSPACE-WIDE live count (25 active media-buyer-test ads across all 6 products) against a PER-COHORT target (default 3), so deficit = 3 − 25 = 0 on every account's run. Superfood Tabs sits at 2/4 active despite 9 ready ad_campaigns in the bin. A second latent bug: replenish publishes into cohort.testMetaAdsetId (the legacy single shared ad set, now null in the per-product model), so even a positive deficit couldn't create a per-test ad set.",
      what: "runMediaBuyerLoop counts live tests, reads the ready bin, and targets replenish PER the product/account cohort it is running — count only the active tests in the cohort's own test_meta_campaign_id, default target 4, and a product-scoped ready bin — then publishes each replenish as a NEW ad set (one ad) in the cohort's test_meta_campaign_id.",
      summary: "Fix the media-buyer replenish scope in src/lib/media-buyer/agent.ts: currentTestCohortSize (agent.ts:825-832) is counted workspace-wide and listReadyToTest (agent.ts:824) is not product-filtered, while the deficit (agent.ts:517) uses a per-cohort target — so replenish is ~always 0. Re-scope both to the cohort under run and publish replenish as a new per-test ad set into cohort.test_meta_campaign_id instead of the legacy testMetaAdsetId (agent.ts:519-526).",
      owner: "growth",
      parent: '[[../functions/growth]] — "Static-ad optimization" mandate: the test→scale loop must actually replenish each product\'s cohort; today the workspace-wide count stalls it. Direct follow-up to [[../specs/media-buyer-product-scoped-test-rail]] (which made cohorts product-aware but left the runner\'s counting/bin/publish workspace-scoped).',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Scope the replenish deficit + ready bin to the cohort under run",
          why: "The deficit uses a workspace-wide live count against a per-cohort target, so it is ~always ≤ 0 and replenish never fires for any product.",
          what: "Count only the active tests in THIS run's cohort (its test_meta_campaign_id), default the target to 4, and filter the ready bin to the cohort's product.",
          body: "In src/lib/media-buyer/agent.ts runMediaBuyerLoop: currentTestCohortSize (lines ~825-832) counts ad_publish_jobs origin='media-buyer-test' publish_active+published WORKSPACE-WIDE — re-scope it to the cohort being run by counting the ACTIVE test ad sets whose meta_campaign_id = cohort.test_meta_campaign_id (via meta_adsets effective_status='ACTIVE', or ad_publish_jobs joined to that campaign). listReadyToTest(admin,{workspaceId}) (line ~824, src/lib/ads/ready-to-test.ts) must accept + apply a productId filter so only the cohort product's ready ad_campaigns are eligible. Set the per-product concurrent target to 4 (align DEFAULT_TEST_COHORT_TARGET or the cohort target with MAX_ACTIVE_TESTS_PER_CAMPAIGN in src/lib/ads/testing-results-sdk.ts). Update the brain page docs/brain/libraries/media-buyer-agent.md (and ready-to-test if its signature changes) in the same PR per CLAUDE.md.",
          verification: "New unit test in src/lib/media-buyer/agent.test.ts: a cohort for product P with 2 active tests in P's test campaign, in a workspace with 25 active tests across OTHER products, computes deficit = 4 − 2 = 2 (not 4 − 25 = 0). listReadyToTest with a productId returns only P's ready campaigns. `npx tsc --noEmit` clean; `npx tsx --test src/lib/media-buyer/agent.test.ts` passes.",
          status: "planned",
        },
        {
          title: "Phase 2 — Publish each replenish as a new per-test ad set in the product's test campaign",
          why: "Replenish targets cohort.testMetaAdsetId (the legacy shared ad set), which is null in the per-product model, so a positive deficit still cannot create a test.",
          what: "For a cohort (adset_per_test), each replenish pick creates a NEW ad set (one ad) under cohort.test_meta_campaign_id at per_test_daily_budget_cents, behind the existing publish gate.",
          body: "In src/lib/media-buyer/agent.ts computeMediaBuyerPlan replenish (lines ~519-526) the action carries testMetaAdsetId: input.cohort.testMetaAdsetId. For the per-adset model, replenish must instead create a new ad set in cohort.test_meta_campaign_id and place one ad in it — reuse the meta-campaign/adset creation primitive (src/lib/meta/recommendation-execute.ts new_adset path) / src/lib/ads/ready-to-test-promote.ts, and keep the src/lib/media-buyer/publish-gate.ts ceiling checks (per_test_daily_budget_cents). Do not exceed the 4 active-per-campaign cap after Phase 1's count. Update docs/brain/libraries/media-buyer-agent.md + the Bianca live-state in docs/brain/functions/growth.md in the same PR per CLAUDE.md.",
          verification: "A replenish action for a per-adset cohort yields an ad_publish_jobs row whose meta_adset_id is a NEW ad set under the cohort's test_meta_campaign_id (never null / never the shared legacy ad set), one ad per ad set, within the daily ceiling. A dry-run/probe against the Superfood Tabs cohort shows a plan with replenish = 2 (2/4 → 4/4). `npx tsc --noEmit` clean; existing media-buyer tests pass.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#static-ad-optimization" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
