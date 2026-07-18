/**
 * Unit tests for the customer-list exclusion composition + weekly refresh watermark —
 * bianca-full-order-history-customer-list-exclusion-audience Fix 1 verification.
 *
 * Pins:
 *   - `ensureExcludedAudiences` composes BOTH ids into `excluded_custom_audiences` and
 *     dedupes against entries already present (so the template's provision-time composition
 *     isn't doubled at replenish time).
 *   - `buildReplenishJobInsert` emits BOTH ids in `create_adset_spec.targeting.excluded_custom_audiences`
 *     when the cohort declares both (the exact shape the publish-gate demands).
 *   - `pickRefreshWatermarkIso` returns the last-run ISO when present, and falls back to
 *     `now - lookback` (default 8d, 24h grace over the 7d cron cadence) on first run — the
 *     "refresh selects only customers since the last-refresh watermark" contract.
 *
 * Run:  npx tsx --test src/lib/media-buyer/all-customers-exclusion.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReplenishJobInsert,
  ensureExcludedAudiences,
  type MediaBuyerReplenishAction,
} from "./agent";
import type { MediaBuyerTestCohort } from "./publish-gate";
import { pickRefreshWatermarkIso } from "../inngest/media-buyer-all-customers-refresh";

const PURCHASER_ID = "23843000000000001";
const ALL_CUSTOMERS_ID = "23843000000000002";

test("ensureExcludedAudiences — appends BOTH ids when neither is present", () => {
  const next = ensureExcludedAudiences({ age_min: 50 }, [PURCHASER_ID, ALL_CUSTOMERS_ID]);
  assert.deepEqual(next, {
    age_min: 50,
    excluded_custom_audiences: [{ id: PURCHASER_ID }, { id: ALL_CUSTOMERS_ID }],
  });
});

test("ensureExcludedAudiences — dedupes against existing entries (no doubling)", () => {
  const targeting = {
    age_min: 50,
    excluded_custom_audiences: [{ id: PURCHASER_ID }],
  };
  const next = ensureExcludedAudiences(targeting, [PURCHASER_ID, ALL_CUSTOMERS_ID]);
  assert.deepEqual(next.excluded_custom_audiences, [
    { id: PURCHASER_ID },
    { id: ALL_CUSTOMERS_ID },
  ]);
});

test("ensureExcludedAudiences — no-op when every id is already present", () => {
  const targeting = {
    age_min: 50,
    excluded_custom_audiences: [{ id: PURCHASER_ID }, { id: ALL_CUSTOMERS_ID }],
  };
  const next = ensureExcludedAudiences(targeting, [PURCHASER_ID, ALL_CUSTOMERS_ID]);
  // Same reference — nothing mutated.
  assert.equal(next, targeting);
});

test("ensureExcludedAudiences — filters out null/empty ids (legacy pre-Fix-1 cohort with only one id)", () => {
  const next = ensureExcludedAudiences({ age_min: 50 }, [PURCHASER_ID, null, "", undefined]);
  assert.deepEqual(next.excluded_custom_audiences, [{ id: PURCHASER_ID }]);
});

test("ensureExcludedAudiences — returns unchanged targeting when no non-null ids are provided", () => {
  const targeting = { age_min: 50 };
  const next = ensureExcludedAudiences(targeting, [null, undefined, ""]);
  assert.equal(next, targeting);
});

function cohortFixture(overrides: Partial<MediaBuyerTestCohort>): MediaBuyerTestCohort {
  return {
    id: "pt-cohort",
    workspaceId: "ws",
    metaAdAccountId: "acct-uuid",
    productId: "prod-PT",
    testMetaAdsetId: null,
    dailyTestCeilingCents: 60000,
    isActive: true,
    notes: null,
    updatedBy: null,
    createdAt: "",
    updatedAt: "",
    defaultMetaAccountId: "act_1",
    defaultMetaPageId: "page-1",
    defaultMetaInstagramUserId: null,
    adsetPerTest: true,
    testMetaCampaignId: "camp-PT",
    perTestDailyBudgetCents: 15000,
    adsetTemplate: {
      optimizationGoal: "OFFSITE_CONVERSIONS",
      billingEvent: "IMPRESSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      pixelId: "px-1",
      customEventType: "PURCHASE",
      targeting: { age_min: 50, age_max: 65 },
    },
    excludedPurchaserAudienceId: null,
    excludedAllCustomersAudienceId: null,
    ...overrides,
  };
}

function replenishAction(): MediaBuyerReplenishAction {
  return {
    kind: "replenish",
    adCampaignId: "ad-camp-1",
    testMetaAdsetId: null,
    adsetPerTest: true,
    dailyTestCeilingCents: 60000,
    rationale: "unit-test",
  };
}

test("buildReplenishJobInsert — cohort with BOTH ids emits BOTH in create_adset_spec.targeting.excluded_custom_audiences", () => {
  const cohort = cohortFixture({
    excludedPurchaserAudienceId: PURCHASER_ID,
    excludedAllCustomersAudienceId: ALL_CUSTOMERS_ID,
  });
  const built = buildReplenishJobInsert({
    workspaceId: "ws",
    cohort,
    action: replenishAction(),
    accountId: "act_1",
    publishIdentity: { pageId: "page-1", instagramUserId: "ig-1" },
    videoId: "vid-1",
    adName: "MB test",
    destination: "https://example.com/pdp",
    headlines: ["h"],
    primaryTexts: ["p"],
    descriptions: [],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const list = (built.createAdsetSpec?.targeting as { excluded_custom_audiences?: unknown })
    ?.excluded_custom_audiences;
  assert.deepEqual(list, [{ id: PURCHASER_ID }, { id: ALL_CUSTOMERS_ID }]);
});

test("buildReplenishJobInsert — cohort with ONLY all-customers id emits ONLY that one (Fix-1 solo path)", () => {
  const cohort = cohortFixture({
    excludedPurchaserAudienceId: null,
    excludedAllCustomersAudienceId: ALL_CUSTOMERS_ID,
  });
  const built = buildReplenishJobInsert({
    workspaceId: "ws",
    cohort,
    action: replenishAction(),
    accountId: "act_1",
    publishIdentity: { pageId: "page-1", instagramUserId: "ig-1" },
    videoId: "vid-1",
    adName: "MB test",
    destination: "https://example.com/pdp",
    headlines: ["h"],
    primaryTexts: ["p"],
    descriptions: [],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const list = (built.createAdsetSpec?.targeting as { excluded_custom_audiences?: unknown })
    ?.excluded_custom_audiences;
  assert.deepEqual(list, [{ id: ALL_CUSTOMERS_ID }]);
});

test("buildReplenishJobInsert — cohort with NEITHER id forwards template unchanged (legacy pre-exclusion row)", () => {
  const cohort = cohortFixture({
    excludedPurchaserAudienceId: null,
    excludedAllCustomersAudienceId: null,
  });
  const built = buildReplenishJobInsert({
    workspaceId: "ws",
    cohort,
    action: replenishAction(),
    accountId: "act_1",
    publishIdentity: { pageId: "page-1", instagramUserId: "ig-1" },
    videoId: "vid-1",
    adName: "MB test",
    destination: "https://example.com/pdp",
    headlines: ["h"],
    primaryTexts: ["p"],
    descriptions: [],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const list = (built.createAdsetSpec?.targeting as { excluded_custom_audiences?: unknown })
    ?.excluded_custom_audiences;
  assert.equal(list, undefined);
});

// ── Watermark contract for the weekly refresh cron ──
// The spec verification pins that the refresh "selects only customers since the last-refresh
// watermark". `pickRefreshWatermarkIso` is what computes that watermark; the cron then reads
// `customers.first_order_at >= watermark` — so this test IS the verification lever.

test("pickRefreshWatermarkIso — returns the last-run ISO when present", () => {
  const last = "2026-07-08T12:00:00.000Z";
  const now = "2026-07-15T12:00:00.000Z";
  assert.equal(pickRefreshWatermarkIso({ lastRunAtIso: last, nowIso: now }), last);
});

test("pickRefreshWatermarkIso — first run falls back to now - 8d (24h grace over 7d cadence)", () => {
  const now = "2026-07-15T12:00:00.000Z";
  const wm = pickRefreshWatermarkIso({ lastRunAtIso: null, nowIso: now });
  const diffMs = Date.parse(now) - Date.parse(wm);
  assert.equal(diffMs, 8 * 24 * 60 * 60 * 1000);
});

test("pickRefreshWatermarkIso — honors a caller-supplied lookback", () => {
  const now = "2026-07-15T12:00:00.000Z";
  const wm = pickRefreshWatermarkIso({ lastRunAtIso: null, nowIso: now, lookbackDays: 30 });
  const diffMs = Date.parse(now) - Date.parse(wm);
  assert.equal(diffMs, 30 * 24 * 60 * 60 * 1000);
});
