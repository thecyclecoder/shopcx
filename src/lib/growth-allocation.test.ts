/**
 * Unit tests for the Phase-1 marginal-leverage readers (growth-allocation Phase 1 of
 * docs/brain/specs/growth-allocation-brain.md). Pins the pure scorers
 * `scoreMetaMarginalLeverage` + `scoreStorefrontMarginalLeverage` against fixture inputs
 * so no database connection is needed.
 *
 * Built-in node:test — run:
 *   npm run test:growth-allocation
 *   (= tsx --test src/lib/growth-allocation.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCALE_UP_ROAS_TRIGGER,
  scoreMetaMarginalLeverage,
  scoreStorefrontMarginalLeverage,
  type MetaScorecardRow,
  type MetaPendingRecommendationRow,
  type StorefrontExperimentRow,
} from "./growth-allocation";

// ── Meta scorer ──────────────────────────────────────────────────────────────────

const scorecard = (overrides: Partial<MetaScorecardRow> = {}): MetaScorecardRow => ({
  id: "sc-1",
  level: "adset",
  object_id: "23851234567890",
  label: "winners-adset",
  snapshot_date: "2026-06-30",
  spend_cents: 250_00,
  revenue_cents: 750_00,
  roas: 3.0,
  ctr_declining: false,
  frequency_rising: false,
  fatigue_score: 0.1,
  ...overrides,
});

const recommendation = (overrides: Partial<MetaPendingRecommendationRow> = {}): MetaPendingRecommendationRow => ({
  id: "rec-1",
  action_type: "new_static_adset",
  title: "Test cold-50+ static angle",
  confidence: 0.7,
  source_metrics: { expected_roas: 2.4 },
  source_scorecard_ids: [],
  ...overrides,
});

test("Meta: best scale-up scorecard ROAS sets metaScore + cites the scorecard row", () => {
  const out = scoreMetaMarginalLeverage({
    scorecards: [
      scorecard({ id: "sc-A", roas: 3.0 }),
      scorecard({ id: "sc-B", roas: 4.2, object_id: "abc", label: "best-adset" }),
      scorecard({ id: "sc-C", roas: 1.1 }), // below trigger — skipped
    ],
    recommendations: [],
    scaleUpRoasTrigger: 1.5,
  });
  assert.equal(out.metaScore, 4.2);
  assert.equal(out.evidence.length, 2);
  const best = out.evidence.find((e) => e.scorecard_id === "sc-B")!;
  assert.equal(best.source, "scorecard_scale_up");
  assert.equal(best.estimated_marginal_roas, 4.2);
  assert.equal(best.label, "best-adset");
});

test("Meta: pending new_static_adset recommendation contributes its source_metrics.expected_roas", () => {
  const out = scoreMetaMarginalLeverage({
    scorecards: [],
    recommendations: [recommendation({ id: "rec-A", source_metrics: { expected_roas: 2.4 } })],
    scaleUpRoasTrigger: DEFAULT_SCALE_UP_ROAS_TRIGGER,
  });
  assert.equal(out.metaScore, 2.4);
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].source, "pending_recommendation");
  assert.equal(out.evidence[0].recommendation_id, "rec-A");
});

test("Meta: scale-up scorecard wins over a weaker pending recommendation", () => {
  const out = scoreMetaMarginalLeverage({
    scorecards: [scorecard({ id: "sc-A", roas: 3.5 })],
    recommendations: [recommendation({ id: "rec-A", source_metrics: { expected_roas: 2.1 } })],
    scaleUpRoasTrigger: 1.5,
  });
  assert.equal(out.metaScore, 3.5);
  assert.equal(out.evidence.length, 2);
});

test("Meta: fatigued scorecards are excluded from scale-up evidence", () => {
  const out = scoreMetaMarginalLeverage({
    scorecards: [
      scorecard({ id: "sc-A", roas: 3.0, ctr_declining: true }),
      scorecard({ id: "sc-B", roas: 3.0, frequency_rising: true }),
    ],
    recommendations: [],
    scaleUpRoasTrigger: 1.5,
  });
  assert.equal(out.metaScore, null);
  assert.equal(out.evidence.length, 0);
  assert.ok(out.flags.includes("no_signal_meta"));
});

test("Meta: non-spend-line recommendation types are ignored (only new_*_adset / new_campaign count)", () => {
  const out = scoreMetaMarginalLeverage({
    scorecards: [],
    recommendations: [
      recommendation({ action_type: "test_benefit_angle", source_metrics: { expected_roas: 5.0 } }),
      recommendation({ action_type: "offer_test", source_metrics: { expected_roas: 6.0 } }),
    ],
    scaleUpRoasTrigger: 1.5,
  });
  assert.equal(out.metaScore, null);
  assert.equal(out.evidence.length, 0);
});

test("Meta: recommendation with no marginal-ROAS estimate is flagged, never silently scored", () => {
  const out = scoreMetaMarginalLeverage({
    scorecards: [],
    recommendations: [recommendation({ id: "rec-X", source_metrics: {} })],
    scaleUpRoasTrigger: 1.5,
  });
  assert.equal(out.metaScore, null);
  assert.equal(out.evidence.length, 0);
  assert.ok(out.flags.some((f) => f.includes("rec-X") && f.includes("no marginal-ROAS estimate")));
});

test("Meta: empty inputs emit no_signal_meta", () => {
  const out = scoreMetaMarginalLeverage({ scorecards: [], recommendations: [], scaleUpRoasTrigger: 1.5 });
  assert.equal(out.metaScore, null);
  assert.deepEqual(out.evidence, []);
  assert.ok(out.flags.includes("no_signal_meta"));
});

// ── Storefront scorer ────────────────────────────────────────────────────────────

const expRow = (overrides: Partial<StorefrontExperimentRow> = {}): StorefrontExperimentRow => ({
  id: "exp-1",
  lever: "hero",
  lander_type: "advertorial",
  last_decision: {
    action: "hold",
    rule: "inconclusive",
    win_prob: 0.6,
    posteriors: [
      { variant_id: "v-ctrl", is_control: true, sessions: 1000, conversions: 30, alpha: 31, beta: 971, ltvPerSession: 300 },
      { variant_id: "v-arm", is_control: false, sessions: 1000, conversions: 45, alpha: 46, beta: 956, winProb: 0.97, ltvPerSession: 450 },
    ],
    at: "2026-06-30T12:00:00Z",
  },
  ...overrides,
});

test("Storefront: best winProb-weighted LTV lift sets storefrontScore", () => {
  const out = scoreStorefrontMarginalLeverage({ experiments: [expRow()] });
  // best winProb 0.97 × lift (450-300=150 cents) = 145.5
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].win_prob, 0.97);
  assert.equal(out.evidence[0].ltv_lift_per_session_cents, 150);
  assert.equal(out.evidence[0].expected_lift_cents, 145.5);
  assert.equal(out.storefrontScore, 145.5);
});

test("Storefront: across multiple experiments, the best expected_lift wins", () => {
  const out = scoreStorefrontMarginalLeverage({
    experiments: [
      expRow({ id: "exp-low", last_decision: {
        action: "hold", rule: "inconclusive", win_prob: 0.6, posteriors: [
          { variant_id: "c", is_control: true, sessions: 100, conversions: 5, alpha: 6, beta: 96, ltvPerSession: 100 },
          { variant_id: "a", is_control: false, sessions: 100, conversions: 6, alpha: 7, beta: 95, winProb: 0.6, ltvPerSession: 120 },
        ],
      }}),
      expRow({ id: "exp-high", last_decision: {
        action: "hold", rule: "inconclusive", win_prob: 0.9, posteriors: [
          { variant_id: "c", is_control: true, sessions: 100, conversions: 5, alpha: 6, beta: 96, ltvPerSession: 200 },
          { variant_id: "a", is_control: false, sessions: 100, conversions: 12, alpha: 13, beta: 89, winProb: 0.9, ltvPerSession: 400 },
        ],
      }}),
    ],
  });
  // exp-low: 0.6 × 20 = 12 ; exp-high: 0.9 × 200 = 180
  assert.equal(out.evidence.length, 2);
  assert.equal(out.storefrontScore, 180);
});

test("Storefront: experiment with no last_decision is flagged, not scored", () => {
  const out = scoreStorefrontMarginalLeverage({
    experiments: [expRow({ id: "exp-empty", last_decision: null })],
  });
  assert.equal(out.storefrontScore, null);
  assert.equal(out.evidence.length, 0);
  assert.ok(out.flags.some((f) => f.includes("exp-empty") && f.includes("no last_decision")));
});

test("Storefront: delivery_flag=failed_to_deliver experiment is skipped (mirrors the bandit refusal)", () => {
  const out = scoreStorefrontMarginalLeverage({
    experiments: [
      expRow({ id: "exp-bad", last_decision: {
        action: "hold", rule: "delivery_audit_failed", win_prob: null, delivery_flag: "failed_to_deliver", posteriors: [
          { variant_id: "c", is_control: true, sessions: 100, conversions: 5, alpha: 6, beta: 96, ltvPerSession: 200 },
          { variant_id: "a", is_control: false, sessions: 100, conversions: 12, alpha: 13, beta: 89, winProb: 0.9, ltvPerSession: 400 },
        ],
      }}),
    ],
  });
  assert.equal(out.storefrontScore, null);
  assert.equal(out.evidence.length, 0);
  assert.ok(out.flags.some((f) => f.includes("exp-bad") && f.includes("delivery-audit")));
});

test("Storefront: a control-beats-arm posterior caps lift at zero (no negative scores)", () => {
  const out = scoreStorefrontMarginalLeverage({
    experiments: [
      expRow({ id: "exp-loser", last_decision: {
        action: "kill", rule: "win_prob<=0.05(control_wins)", win_prob: 0.04, posteriors: [
          { variant_id: "c", is_control: true, sessions: 1000, conversions: 80, alpha: 81, beta: 921, ltvPerSession: 800 },
          { variant_id: "a", is_control: false, sessions: 1000, conversions: 30, alpha: 31, beta: 971, winProb: 0.04, ltvPerSession: 300 },
        ],
      }}),
    ],
  });
  // lift = -500 → expected_lift floored at 0; storefrontScore = 0 (still counts as evidence)
  assert.equal(out.evidence.length, 1);
  assert.equal(out.evidence[0].ltv_lift_per_session_cents, -500);
  assert.equal(out.evidence[0].expected_lift_cents, 0);
  assert.equal(out.storefrontScore, 0);
});

test("Storefront: empty input emits no_signal_storefront", () => {
  const out = scoreStorefrontMarginalLeverage({ experiments: [] });
  assert.equal(out.storefrontScore, null);
  assert.deepEqual(out.evidence, []);
  assert.ok(out.flags.includes("no_signal_storefront"));
});
