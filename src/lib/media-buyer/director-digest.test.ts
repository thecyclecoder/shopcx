/**
 * Unit test for media-buyer-digest-consolidate-product-names-suppress-noop Phase 1.
 *
 * Pins two gates on `composeDigest`:
 *   1) A pass with active policy but zero total actions returns `hasRecommendations=false`
 *      (so `deliverMediaBuyerDigest` will suppress the post — no "no changes recommended"
 *      Slack noise every 2h).
 *   2) A cohort with a resolved `productTitle` labels its line by that title
 *      ("Amazing Coffee — …"), and only a null-product cohort keeps the
 *      `account <id8>` fallback.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/director-digest.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { composeDigest, type AccountPlan } from "./director-digest";
import type {
  MediaBuyerPlan,
  MediaBuyerPromoteAction,
  MediaBuyerReplenishAction,
} from "./agent";

function plan(overrides: Partial<MediaBuyerPlan> = {}): MediaBuyerPlan {
  return {
    policyActive: true,
    policyVersionId: "policy-1",
    cohortConfigured: true,
    cohortTargetCount: 4,
    currentTestCohortSize: 4,
    promote: [],
    kill: [],
    replenish: [],
    fatigueReplenish: [],
    summary: "cohort full; no winners; no losers",
    ...overrides,
  };
}

function promote(): MediaBuyerPromoteAction {
  return {
    kind: "promote",
    sourceMetaAdId: "ad-1",
    roas: 3.2,
    spendCents: 5000,
    targetLevel: "adset",
    targetObjectId: "as-1",
    beforeBudgetCents: 5000,
    afterBudgetCents: 10000,
    rationale: "roas>floor",
    policyVersionId: "policy-1",
    sourceAdCampaignId: null,
  };
}

function replenish(): MediaBuyerReplenishAction {
  return {
    kind: "replenish",
    adCampaignId: "camp-1",
    testMetaAdsetId: "meta-as-1",
    adsetPerTest: false,
    dailyTestCeilingCents: 60_000,
    rationale: "top up",
  };
}

test("composeDigest: active policy + zero actions reports hasRecommendations=false", () => {
  const plans: AccountPlan[] = [
    { account: "acct-01234567-abcd", productId: "prod-1", productTitle: "Amazing Coffee", plan: plan() },
  ];
  const { hasRecommendations, text } = composeDigest(plans);
  assert.equal(hasRecommendations, false, "no promote/kill/replenish/fatigue → no actionable recommendations");
  // Header still lists the cohort count so the composition is stable, but the caller
  // (`deliverMediaBuyerDigest`) must suppress the post on hasRecommendations=false.
  assert.match(text, /no changes recommended this cycle/);
});

test("composeDigest: cohort with productTitle labels line by product, not account id", () => {
  const plans: AccountPlan[] = [
    {
      account: "acct-abcdef12-3456",
      productId: "prod-1",
      productTitle: "Amazing Coffee",
      plan: plan({
        promote: [promote()],
        summary: "1 winner to scale",
      }),
    },
  ];
  const { hasRecommendations, text } = composeDigest(plans);
  assert.equal(hasRecommendations, true);
  assert.match(text, /• Amazing Coffee — 1 winner to scale/, "line labelled by product title");
  assert.doesNotMatch(text, /• account /, "no account-id line label when productTitle is present");
});

test("composeDigest: null-cohort (product-null) falls back to `account <id8>` label", () => {
  const plans: AccountPlan[] = [
    {
      account: "acct-legacy-tabs-01",
      productId: null,
      productTitle: null,
      plan: plan({
        replenish: [replenish()],
        summary: "top up",
      }),
    },
  ];
  const { hasRecommendations, text } = composeDigest(plans);
  assert.equal(hasRecommendations, true);
  assert.match(text, /• account acct-leg — top up/, "null-product cohort keeps account fallback");
});

test("composeDigest: mixed cohorts — product-labelled + fallback in the same digest", () => {
  const plans: AccountPlan[] = [
    {
      account: "acct-shared-1",
      productId: "prod-coffee",
      productTitle: "Amazing Coffee",
      plan: plan({
        promote: [promote()],
        summary: "scale 1",
      }),
    },
    {
      account: "acct-shared-1",
      productId: "prod-creamer",
      productTitle: "Superfood Creamer",
      plan: plan({ summary: "hold" }),
    },
  ];
  const { text, hasRecommendations } = composeDigest(plans);
  assert.equal(hasRecommendations, true);
  assert.match(text, /• Amazing Coffee — scale 1/);
  assert.match(text, /• Superfood Creamer — hold/);
  assert.doesNotMatch(text, /• account /);
});
