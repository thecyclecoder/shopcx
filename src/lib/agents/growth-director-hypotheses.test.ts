/**
 * Unit tests for the Growth Director Phase-2 hypothesis generator
 * (growth-director-analytical-brief spec § Phase 2).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:growth-director-hypotheses
 *   (= tsx --test src/lib/agents/growth-director-hypotheses.test.ts)
 *
 * The verification the SPEC asserts (baked into these tests):
 *   1. High-CTR / zero-ATC fixture cohort ⇒ `funnel_not_creative` hypothesis
 *      citing the LPV→ATC cliff.
 *   2. Below-floor small-sample cohort ⇒ NO hypothesis; the creative lands on
 *      `belowFloor` with the SPECIFIC gate that filtered it.
 *   3. Every hypothesis carries `evidence` + `confidence`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateGrowthHypotheses,
  DEFAULT_MIN_SPEND_CENTS,
  DEFAULT_MIN_LANDING_PAGE_VIEWS,
  DEFAULT_MIN_IMPRESSIONS,
  SIGNAL_CLIFF_LPV_TO_ATC_RATE,
  SIGNAL_HEALTHY_CTR_PCT,
  SIGNAL_FORMAT_ROAS_MULTIPLIER,
} from "./growth-director-hypotheses";
import type {
  AnalyticalBriefResult,
  CohortSummary,
  CreativeScorecardRow,
} from "./growth-director-analytical-brief";
import { UNKNOWN_COHORT } from "./growth-director-analytical-brief";

// ── Fixture builders ─────────────────────────────────────────────────────────

function makeRow(over: Partial<CreativeScorecardRow> = {}): CreativeScorecardRow {
  const base: CreativeScorecardRow = {
    cohort: "amazing-coffee",
    cohort_label: "Amazing Coffee",
    meta_ad_id: "ad-1",
    meta_ad_name: "Amazing Coffee — Advertorial v1",
    meta_adset_id: "adset-1",
    meta_campaign_id: "camp-1",
    destination_url: "https://shop.example.com/amazing-coffee?variant=advertorial",
    meta: {
      spend_cents: 15_000, impressions: 5000, clicks: 100,
      ctr: 2.0, cpc_cents: 150, cpm_cents: 3000, frequency: 1.5,
      purchases: 3, revenue_cents: 45_000, roas: 3.0, cpa_cents: 5000,
    },
    funnel: {
      landing_page_views: 90, add_to_carts: 20,
      initiate_checkouts: 12, purchases: 3,
    },
    dropoffs: {
      lpv_to_atc_rate: 0.2222, atc_to_checkout_rate: 0.6,
      checkout_to_purchase_rate: 0.25,
      lpv_to_atc_gap: 70, atc_to_checkout_gap: 8, checkout_to_purchase_gap: 9,
    },
    variants: [],
    ...over,
  };
  return base;
}

function makeCohort(over: Partial<CohortSummary> = {}): CohortSummary {
  const totals = { ...makeRow().meta, ...makeRow().funnel };
  return {
    cohort: "amazing-coffee",
    cohort_label: "Amazing Coffee",
    creatives: 1,
    totals,
    ...over,
  };
}

function makeBrief(rows: CreativeScorecardRow[], cohorts: CohortSummary[]): AnalyticalBriefResult {
  return {
    workspaceId: "ws-1",
    windowStartIso: "2026-07-01T00:00:00Z",
    windowEndIso: "2026-07-08T23:59:59Z",
    cohorts,
    rows,
    unresolvedAdIds: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("high-CTR / zero-ATC fixture ⇒ funnel_not_creative hypothesis citing the LPV→ATC cliff", () => {
  // The 2026-07-08 live-read Tabs pattern the spec calls out: real clicks land, zero carts.
  const tabsCliff = makeRow({
    cohort: "tabs",
    cohort_label: "Tabs",
    meta_ad_id: "ad-tabs-cliff",
    meta_ad_name: "Tabs — Before/After v3",
    meta: {
      spend_cents: 40_000, impressions: 20_000, clicks: 400,
      ctr: 2.0, cpc_cents: 100, cpm_cents: 2000, frequency: 1.8,
      purchases: 0, revenue_cents: 0, roas: 0, cpa_cents: null,
    },
    funnel: {
      landing_page_views: 300, add_to_carts: 0,
      initiate_checkouts: 0, purchases: 0,
    },
    dropoffs: {
      lpv_to_atc_rate: 0, atc_to_checkout_rate: null,
      checkout_to_purchase_rate: null,
      lpv_to_atc_gap: 300, atc_to_checkout_gap: 0, checkout_to_purchase_gap: 0,
    },
  });
  const cohort = makeCohort({
    cohort: "tabs",
    cohort_label: "Tabs",
    creatives: 1,
    totals: { ...tabsCliff.meta, ...tabsCliff.funnel },
  });

  const { hypotheses, belowFloor } = generateGrowthHypotheses(makeBrief([tabsCliff], [cohort]));
  const funnel = hypotheses.find((h) => h.kind === "funnel_not_creative");
  assert.ok(funnel, "expected a funnel_not_creative hypothesis on the high-CTR/zero-ATC row");
  assert.equal(funnel!.cohort, "tabs");
  assert.equal(funnel!.meta_ad_id, "ad-tabs-cliff");
  // The verification says the cliff MUST be cited on the evidence.
  const cited = funnel!.evidence.map((e) => e.field);
  assert.ok(cited.includes("lpv_to_atc_rate"), "evidence must cite lpv_to_atc_rate");
  assert.ok(cited.includes("landing_page_views"), "evidence must cite landing_page_views");
  assert.ok(cited.includes("ctr"), "evidence must cite ctr");
  // The verification says each hypothesis carries evidence + confidence.
  assert.ok(funnel!.evidence.length >= 3);
  assert.ok(funnel!.confidence === "medium" || funnel!.confidence === "high");
  // Nothing else lands on belowFloor for this creative — the only entry allowed here is
  // the delivery gate NOT filtering it (there's no delivery anomaly on this ad).
  assert.equal(belowFloor.filter((b) => b.meta_ad_id === "ad-tabs-cliff").length, 0);
});

test("below-floor small-sample cohort ⇒ NO hypothesis; the creative lands on belowFloor with the reason", () => {
  // Below every gate: $10 spend, 100 impressions, 5 LPV. Even if the cliff SIGNAL fires,
  // the sample gate refuses to emit a call.
  const smallSample = makeRow({
    cohort: "coffee-small",
    cohort_label: "Small Coffee Cohort",
    meta_ad_id: "ad-small",
    meta: {
      spend_cents: 1_000, impressions: 100, clicks: 3,
      ctr: 3.0, cpc_cents: 333, cpm_cents: 10_000, frequency: 1,
      purchases: 0, revenue_cents: 0, roas: 0, cpa_cents: null,
    },
    funnel: { landing_page_views: 5, add_to_carts: 0, initiate_checkouts: 0, purchases: 0 },
    dropoffs: {
      lpv_to_atc_rate: 0, atc_to_checkout_rate: null, checkout_to_purchase_rate: null,
      lpv_to_atc_gap: 5, atc_to_checkout_gap: 0, checkout_to_purchase_gap: 0,
    },
  });
  const cohort = makeCohort({
    cohort: "coffee-small", cohort_label: "Small Coffee Cohort", creatives: 1,
    totals: { ...smallSample.meta, ...smallSample.funnel },
  });

  const { hypotheses, belowFloor } = generateGrowthHypotheses(makeBrief([smallSample], [cohort]));

  assert.equal(hypotheses.length, 0, "no hypothesis on a below-floor cohort");
  const entry = belowFloor.find((b) => b.meta_ad_id === "ad-small");
  assert.ok(entry, "creative must land on belowFloor with a specific reason");
  assert.match(entry!.reason, /sample gate/);
  // And it must cite each SPECIFIC gate it missed — Director reads it verbatim into the verdict.
  assert.match(entry!.reason, /spend/);
  assert.match(entry!.reason, /impressions/);
  assert.match(entry!.reason, /landing_page_views/);
  // The cohort ALSO lands on belowFloor with its own cohort-level reason (spend below floor).
  const cohortEntry = belowFloor.find((b) => !b.meta_ad_id && b.cohort === "coffee-small");
  assert.ok(cohortEntry, "cohort must land on belowFloor too — cohort-level format gate");
  assert.match(cohortEntry!.reason, /cohort spend/);
});

test("format-effectiveness fires when top-variant ROAS ≥ multiplier × bottom-variant ROAS, both past floor", () => {
  const rowA = makeRow({
    cohort: "amazing-coffee", cohort_label: "Amazing Coffee", meta_ad_id: "ad-A",
    meta: {
      spend_cents: 20_000, impressions: 10_000, clicks: 200, ctr: 2.0,
      cpc_cents: 100, cpm_cents: 2000, frequency: 1.5,
      purchases: 10, revenue_cents: 100_000, roas: 5.0, cpa_cents: 2000,
    },
    variants: [
      { variant: "advertorial", spend_cents: 20_000, revenue_cents: 100_000, roas: 5.0, sessions: 200, orders: 10 },
      { variant: "beforeafter", spend_cents: 20_000, revenue_cents: 30_000, roas: 1.5, sessions: 180, orders: 3 },
    ],
  });
  const cohort = makeCohort({ creatives: 1, totals: { ...rowA.meta, ...rowA.funnel } });

  const { hypotheses } = generateGrowthHypotheses(makeBrief([rowA], [cohort]));
  const fmt = hypotheses.find((h) => h.kind === "format_effectiveness");
  assert.ok(fmt, "expected a format_effectiveness hypothesis");
  const cited = fmt!.evidence.map((e) => e.field);
  assert.ok(cited.includes("top_variant"));
  assert.ok(cited.includes("bottom_variant"));
  assert.ok(cited.includes("format_roas_multiplier"));
  // Multiplier > 1.5 (5.0 / 1.5 = 3.33), so it must clear the floor.
  const mult = fmt!.evidence.find((e) => e.field === "format_roas_multiplier")!;
  assert.ok(typeof mult.value === "number" && (mult.value as number) >= SIGNAL_FORMAT_ROAS_MULTIPLIER);
});

test("delivery_anomaly fires on high CPM AND on high frequency; each carries the threshold cited", () => {
  const highCpm = makeRow({
    meta_ad_id: "ad-cpm",
    meta: {
      spend_cents: 30_000, impressions: 3_000, clicks: 60, ctr: 2.0,
      cpc_cents: 500, cpm_cents: 10_000, frequency: 1.2,
      purchases: 1, revenue_cents: 5_000, roas: 0.16, cpa_cents: 30_000,
    },
  });
  const highFreq = makeRow({
    meta_ad_id: "ad-freq",
    meta: {
      spend_cents: 30_000, impressions: 20_000, clicks: 300, ctr: 1.5,
      cpc_cents: 100, cpm_cents: 1500, frequency: 5.5,
      purchases: 4, revenue_cents: 40_000, roas: 1.33, cpa_cents: 7500,
    },
  });
  const cohort = makeCohort({
    creatives: 2,
    totals: {
      spend_cents: 60_000, impressions: 23_000, clicks: 360, ctr: 1.6,
      cpc_cents: 166, cpm_cents: 2609, frequency: 3.3, revenue_cents: 45_000,
      roas: 0.75, cpa_cents: 12_000,
      landing_page_views: 180, add_to_carts: 40, initiate_checkouts: 20, purchases: 8,
    } as CohortSummary["totals"],
  });

  const { hypotheses } = generateGrowthHypotheses(makeBrief([highCpm, highFreq], [cohort]));
  const cpm = hypotheses.find((h) => h.kind === "delivery_anomaly" && h.meta_ad_id === "ad-cpm");
  const freq = hypotheses.find((h) => h.kind === "delivery_anomaly" && h.meta_ad_id === "ad-freq");
  assert.ok(cpm, "expected a delivery_anomaly on the high-CPM ad");
  assert.ok(freq, "expected a delivery_anomaly on the high-frequency ad");
  assert.ok(cpm!.evidence.some((e) => e.field === "cpm_cents" && e.threshold != null));
  assert.ok(freq!.evidence.some((e) => e.field === "frequency" && e.threshold != null));
});

test("audience_signal fires on cohort-wide low CVR with healthy CTR (≥2 qualifying creatives)", () => {
  const mkQualified = (id: string): CreativeScorecardRow => makeRow({
    meta_ad_id: id,
    meta: {
      spend_cents: 25_000, impressions: 10_000, clicks: 150, ctr: 1.5,
      cpc_cents: 166, cpm_cents: 2500, frequency: 1.6,
      purchases: 0, revenue_cents: 0, roas: 0, cpa_cents: null,
    },
    funnel: { landing_page_views: 120, add_to_carts: 40, initiate_checkouts: 10, purchases: 0 },
    dropoffs: {
      lpv_to_atc_rate: 0.33, atc_to_checkout_rate: 0.25, checkout_to_purchase_rate: 0,
      lpv_to_atc_gap: 80, atc_to_checkout_gap: 30, checkout_to_purchase_gap: 10,
    },
  });
  const rA = mkQualified("ad-aud-A");
  const rB = mkQualified("ad-aud-B");
  const cohort = makeCohort({
    creatives: 2,
    totals: {
      spend_cents: 50_000, impressions: 20_000, clicks: 300, ctr: 1.5,
      cpc_cents: 166, cpm_cents: 2500, frequency: 1.6, revenue_cents: 0,
      roas: 0, cpa_cents: null,
      landing_page_views: 240, add_to_carts: 80, initiate_checkouts: 20, purchases: 0,
    } as CohortSummary["totals"],
  });

  const { hypotheses } = generateGrowthHypotheses(makeBrief([rA, rB], [cohort]));
  const aud = hypotheses.find((h) => h.kind === "audience_signal");
  assert.ok(aud, "expected an audience_signal hypothesis on cohort-wide zero-CVR");
  const cited = aud!.evidence.map((e) => e.field);
  assert.ok(cited.includes("cohort_cvr"));
  assert.ok(cited.includes("mean_ctr"));
  assert.ok(cited.includes("qualifying_creatives"));
});

test("UNKNOWN_COHORT creatives NEVER emit a hypothesis — they land on belowFloor with reason 'unknown_cohort'", () => {
  const unresolved = makeRow({
    cohort: UNKNOWN_COHORT,
    cohort_label: "Unknown cohort",
    meta_ad_id: "ad-unknown",
    meta: {
      spend_cents: 100_000, impressions: 50_000, clicks: 1000, ctr: 2.0,
      cpc_cents: 100, cpm_cents: 2000, frequency: 1.5,
      purchases: 0, revenue_cents: 0, roas: 0, cpa_cents: null,
    },
    funnel: { landing_page_views: 400, add_to_carts: 0, initiate_checkouts: 0, purchases: 0 },
    dropoffs: {
      lpv_to_atc_rate: 0, atc_to_checkout_rate: null, checkout_to_purchase_rate: null,
      lpv_to_atc_gap: 400, atc_to_checkout_gap: 0, checkout_to_purchase_gap: 0,
    },
  });
  const cohort = makeCohort({
    cohort: UNKNOWN_COHORT, cohort_label: "Unknown cohort", creatives: 1,
    totals: { ...unresolved.meta, ...unresolved.funnel },
  });

  const { hypotheses, belowFloor } = generateGrowthHypotheses(makeBrief([unresolved], [cohort]));
  assert.equal(hypotheses.length, 0, "no hypothesis on unknown-cohort creatives");
  const entry = belowFloor.find((b) => b.meta_ad_id === "ad-unknown");
  assert.ok(entry);
  assert.match(entry!.reason, /unknown_cohort/);
});

test("gate defaults + threshold constants exposed so callers cite the exact floor in prompts", () => {
  assert.equal(DEFAULT_MIN_SPEND_CENTS, 5_000);
  assert.equal(DEFAULT_MIN_LANDING_PAGE_VIEWS, 30);
  assert.equal(DEFAULT_MIN_IMPRESSIONS, 500);
  assert.ok(SIGNAL_CLIFF_LPV_TO_ATC_RATE > 0 && SIGNAL_CLIFF_LPV_TO_ATC_RATE < 1);
  assert.ok(SIGNAL_HEALTHY_CTR_PCT > 0);
  assert.ok(SIGNAL_FORMAT_ROAS_MULTIPLIER > 1);
});
