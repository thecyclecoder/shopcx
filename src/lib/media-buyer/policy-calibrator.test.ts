/**
 * Unit tests for the pure per-cohort iteration_policies calibrator.
 * Implements the `media-buyer-per-cohort-iteration-policy-calibration` spec Phase 1
 * verification harness:
 *   • narrow-distribution cohort (all ROAS near 2.0 → tight bands)
 *   • wide-distribution cohort (0.5..8.0 → clamped bands)
 *   • low-spend cohort (all spend < $50 → floor pins to $50)
 *   • empty roasSamples → throws a typed error (category error, not silent zero-policy)
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/policy-calibrator.test.ts
 *   npm run test:media-buyer-policy-calibrator
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  calibrateMediaBuyerPolicy,
  EmptyCalibrationSampleError,
} from "./policy-calibrator";

// ── Case 1 — narrow-distribution cohort (all ROAS near 2.0 → tight bands) ────────

test("calibrateMediaBuyerPolicy — narrow-distribution ROAS near 2.0 → tight bands (floor+trigger both derived, floor clamps to 2.0)", () => {
  const result = calibrateMediaBuyerPolicy({
    roasSamples: [1.9, 1.95, 2.0, 2.05, 2.1],
    spendSamplesCents: [10_000, 15_000, 20_000, 25_000, 30_000],
    recentAccountSpendCents: 500_000, // $5000 over 7d
  });
  // median = 2.0, clamped to (0.8, 2.0) → 2.0 exactly.
  assert.equal(result.draft.roas_floor, 2.0);
  // p75 = 2.05 → but floor × 1.5 = 3.0, and 3.0 > 2.05 → trigger clamps UP to 3.0.
  assert.equal(result.draft.scale_up_roas_trigger, 3.0);
  // p60 = 0.6*(5-1) = 2.4 → interp between spend[2]=20_000 and spend[3]=25_000
  // with frac 0.4 → 20_000*0.6 + 25_000*0.4 = 22_000. Above $50 floor → 22_000.
  assert.equal(result.draft.pause_min_spend_cents, 22_000);
  // 10% of $5000 = $500 = 50_000 cents.
  assert.equal(result.draft.per_account_daily_budget_delta_ceiling_cents, 50_000);
  // Untouched knobs default to the seed (no currentPolicy passed).
  assert.equal(result.draft.scale_up_step_pct, 0.15);
  assert.equal(result.draft.scale_up_cap_pct, 0.25);
  assert.match(result.rationale, /median\(roas\)=2\.00/);
});

// ── Case 2 — wide-distribution cohort (0.5..8.0 → clamped bands) ────────────────

test("calibrateMediaBuyerPolicy — wide-distribution ROAS 0.5..8.0 → floor + trigger BOTH clamp to their caps", () => {
  const result = calibrateMediaBuyerPolicy({
    roasSamples: [0.5, 1.0, 2.0, 4.0, 8.0],
    spendSamplesCents: [5_000, 10_000, 20_000, 40_000, 80_000],
    recentAccountSpendCents: 1_000_000, // $10k
  });
  // median = 2.0 → clamped to (0.8, 2.0) → 2.0.
  assert.equal(result.draft.roas_floor, 2.0);
  // p75 = 0.75 * (5-1) = 3.0 → interpolates to sample[3] = 4.0; clamped to
  // (floor*1.5=3.0, 5.0) → 4.0.
  assert.equal(result.draft.scale_up_roas_trigger, 4.0);
  // p60 = 0.6 * (5-1) = 2.4 → interpolates between spend[2]=20_000 and spend[3]=40_000
  // with frac 0.4 → 20_000*0.6 + 40_000*0.4 = 28_000. Above $50 floor → 28_000.
  assert.equal(result.draft.pause_min_spend_cents, 28_000);
  // 10% of $10k = $1000 = 100_000 cents.
  assert.equal(result.draft.per_account_daily_budget_delta_ceiling_cents, 100_000);
});

test("calibrateMediaBuyerPolicy — wide-distribution ROAS below the 0.8 floor clamp → roas_floor pins to 0.8", () => {
  const result = calibrateMediaBuyerPolicy({
    roasSamples: [0.1, 0.2, 0.3, 0.4, 0.5],
    spendSamplesCents: [10_000, 10_000, 10_000, 10_000, 10_000],
    recentAccountSpendCents: 200_000,
  });
  // median = 0.3 → clamped UP to 0.8.
  assert.equal(result.draft.roas_floor, 0.8);
  // p75 = 0.4 → clamped UP to floor*1.5 = 1.2.
  assert.equal(result.draft.scale_up_roas_trigger, 1.2);
});

// ── Case 3 — low-spend cohort (all spend < $50 → floor pins to $50) ─────────────

test("calibrateMediaBuyerPolicy — low-spend cohort (all spend < $50) → pause_min_spend_cents pins to the $50 floor", () => {
  const result = calibrateMediaBuyerPolicy({
    roasSamples: [1.5, 1.5, 1.5, 1.5, 1.5],
    spendSamplesCents: [1_000, 2_000, 3_000, 4_000, 4_999], // all < $50
    recentAccountSpendCents: 20_000, // $200
  });
  // p60 = 3_400 → below $50 floor → pins to 5_000.
  assert.equal(result.draft.pause_min_spend_cents, 5_000);
  // 10% of $200 = $20 = 2_000 cents (above $10 floor).
  assert.equal(result.draft.per_account_daily_budget_delta_ceiling_cents, 2_000);
});

test("calibrateMediaBuyerPolicy — zero recent account spend → per_account_daily_budget_delta_ceiling_cents pins to the $10 floor", () => {
  const result = calibrateMediaBuyerPolicy({
    roasSamples: [1.5, 2.0, 2.5],
    spendSamplesCents: [10_000, 20_000, 30_000],
    recentAccountSpendCents: 0,
  });
  assert.equal(result.draft.per_account_daily_budget_delta_ceiling_cents, 1_000);
});

// ── Case 4 — empty roasSamples → typed error (spec verification #2) ─────────────

test("calibrateMediaBuyerPolicy — empty roasSamples → throws EmptyCalibrationSampleError (calibration on zero data is a category error)", () => {
  assert.throws(
    () =>
      calibrateMediaBuyerPolicy({
        roasSamples: [],
        spendSamplesCents: [10_000],
        recentAccountSpendCents: 100_000,
      }),
    (err: unknown) => err instanceof EmptyCalibrationSampleError,
  );
});

test("calibrateMediaBuyerPolicy — all-NaN roasSamples filter to empty → throws EmptyCalibrationSampleError", () => {
  assert.throws(
    () =>
      calibrateMediaBuyerPolicy({
        roasSamples: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        spendSamplesCents: [10_000],
        recentAccountSpendCents: 100_000,
      }),
    (err: unknown) => err instanceof EmptyCalibrationSampleError,
  );
});

// ── Carry-through — currentPolicy's untouched knobs flow through untouched ──────

test("calibrateMediaBuyerPolicy — currentPolicy's scale_up_step_pct + scale_up_cap_pct carry through (never re-proposed)", () => {
  const result = calibrateMediaBuyerPolicy({
    roasSamples: [2.0, 2.0, 2.0],
    spendSamplesCents: [10_000],
    recentAccountSpendCents: 100_000,
    currentPolicy: {
      scale_up_step_pct: 0.33,
      scale_up_cap_pct: 0.66,
      scale_down_step_pct: 0.44,
    },
  });
  assert.equal(result.draft.scale_up_step_pct, 0.33);
  assert.equal(result.draft.scale_up_cap_pct, 0.66);
  assert.equal(result.draft.scale_down_step_pct, 0.44);
});
