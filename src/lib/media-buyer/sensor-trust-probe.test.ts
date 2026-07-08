/**
 * Unit tests for the Media Buyer sensor-trust probe — media-buyer-sensor-trust-probe
 * Phase 2 verification harness.
 *
 * The spec's Phase 2 verification calls out:
 *   • On npm run test:media-buyer-sensor-trust → expect the pure computeSensorTrust
 *     fixtures pass.
 *   • On a workspace with zero meta_attribution_daily rows in the window → expect
 *     band='red' with reasons carrying 'insufficient_sample' and sample_orders=0.
 *   • Band math pins against fixture totals — the same inputs must produce the
 *     same verdict every time so the Phase 3 short-circuit is deterministic.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/sensor-trust-probe.test.ts
 *   npm run test:media-buyer-sensor-trust
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeSensorTrust,
  DEFAULT_GREEN_MIN_COVERAGE,
  DEFAULT_YELLOW_MIN_COVERAGE,
  DEFAULT_MAX_UNRESOLVED_SHARE,
  MIN_SAMPLE_ORDERS,
  type SensorTrustTotals,
  type SensorTrustThresholds,
} from "./sensor-trust-probe";

function totals(overrides: Partial<SensorTrustTotals> = {}): SensorTrustTotals {
  return {
    resolvedRevenueCents: 0,
    unresolvedRevenueCents: 0,
    attributedSpendCents: 0,
    totalSpendCents: 0,
    resolvedOrders: 0,
    unresolvedOrders: 0,
    ...overrides,
  };
}

function thresholds(overrides: Partial<SensorTrustThresholds> = {}): SensorTrustThresholds {
  return { ...overrides };
}

// ── Verification #1 — zero rows in the window → band='red' + insufficient_sample ──

test("computeSensorTrust — empty window (zero orders + zero revenue) → band='red' with insufficient_sample + sample_orders=0", () => {
  const v = computeSensorTrust(totals(), thresholds());
  assert.equal(v.band, "red");
  assert.equal(v.sampleOrders, 0);
  assert.ok(v.reasons.includes("insufficient_sample"));
  // No revenue → all three ratios are null.
  assert.equal(v.coverageRatio, null);
  assert.equal(v.unresolvedRevenueShare, null);
  assert.equal(v.spendAllocationRatio, null);
});

// ── Verification #2 — the happy path pins to green ────────────────────────────

test("computeSensorTrust — clean window (high coverage + low unresolved + full spend allocation) → band='green'", () => {
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 90_000, // $900 resolved
      unresolvedRevenueCents: 10_000, // $100 unresolved → coverage 0.9
      attributedSpendCents: 200_000, // $2000 attributed
      totalSpendCents: 200_000, // $2000 total → allocation 1.0
      resolvedOrders: 40,
      unresolvedOrders: 2,
    }),
    thresholds(),
  );
  assert.equal(v.band, "green");
  assert.equal(v.coverageRatio, 0.9);
  assert.equal(v.unresolvedRevenueShare, 0.1);
  assert.equal(v.spendAllocationRatio, 1);
  assert.equal(v.sampleOrders, 42);
  assert.equal(v.reasons.length, 0);
});

// ── Verification #3 — coverage between yellow + green floors → band='yellow' ──

test("computeSensorTrust — coverage strictly between yellow and green floors, unresolved within cap → yellow", () => {
  // Craft coverage = 0.6 exactly (< 0.7 green, ≥ 0.5 yellow); unresolved share also 0.4 → over the 0.3 cap.
  // First: build a case where unresolved share is UNDER the cap so ONLY the coverage rail acts.
  // Coverage 0.6 requires unresolved / total = 0.4. Under the 0.3 cap needs unresolved / total ≤ 0.3.
  // These are incompatible with defaults — override maxUnresolvedShare to 0.5 to isolate the coverage rail.
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 60_000,
      unresolvedRevenueCents: 40_000, // coverage 0.6, unresolved share 0.4
      attributedSpendCents: 200_000,
      totalSpendCents: 200_000,
      resolvedOrders: 25,
      unresolvedOrders: 10,
    }),
    thresholds({ maxUnresolvedShare: 0.5 }),
  );
  assert.equal(v.coverageRatio, 0.6);
  assert.equal(v.band, "yellow");
  assert.ok(v.reasons.includes("coverage_below_green"));
});

// ── Verification #4 — coverage below yellow floor → band='red' + low_coverage ──

test("computeSensorTrust — coverage below the yellow floor → band='red' with low_coverage", () => {
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 30_000, // coverage 0.3 — below 0.5 yellow floor
      unresolvedRevenueCents: 70_000,
      attributedSpendCents: 200_000,
      totalSpendCents: 200_000,
      resolvedOrders: 20,
      unresolvedOrders: 30,
    }),
    thresholds(),
  );
  assert.equal(v.coverageRatio, 0.3);
  assert.equal(v.band, "red");
  assert.ok(v.reasons.includes("low_coverage"));
});

// ── Verification #5 — unresolved share over cap alone demotes to red ─────────

test("computeSensorTrust — unresolved share over the cap → band='red' with unresolved_share_over_cap", () => {
  // Coverage 0.85 (well above green), but unresolved share is 0.15 — under default 0.3 cap. Push it over.
  // Use maxUnresolvedShare=0.1 so 0.15 > 0.1 triggers.
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 85_000,
      unresolvedRevenueCents: 15_000,
      attributedSpendCents: 200_000,
      totalSpendCents: 200_000,
      resolvedOrders: 30,
      unresolvedOrders: 8,
    }),
    thresholds({ maxUnresolvedShare: 0.1 }),
  );
  assert.equal(v.coverageRatio, 0.85);
  assert.equal(v.unresolvedRevenueShare, 0.15);
  assert.ok(v.reasons.includes("unresolved_share_over_cap"));
  assert.equal(v.band, "red");
});

// ── Verification #6 — spend-allocation thin secondary rail demotes to yellow ──

test("computeSensorTrust — coverage green but spend allocation thin → band='yellow' with spend_allocation_thin", () => {
  // Coverage is fine, but attributed_spend / total insights spend is under the yellow floor.
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 90_000,
      unresolvedRevenueCents: 10_000, // coverage 0.9 → green
      attributedSpendCents: 40_000, // allocation 0.2 — under 0.5 yellow floor
      totalSpendCents: 200_000,
      resolvedOrders: 30,
      unresolvedOrders: 5,
    }),
    thresholds(),
  );
  assert.equal(v.coverageRatio, 0.9);
  assert.equal(v.spendAllocationRatio, 0.2);
  assert.equal(v.band, "yellow");
  assert.ok(v.reasons.includes("spend_allocation_thin"));
});

// ── Verification #7 — thresholds default when the cohort leaves them null ────

test("computeSensorTrust — null thresholds fall back to the code-level defaults", () => {
  // With a coverage RIGHT AT the green default floor and low unresolved share, no threshold override → green.
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: DEFAULT_GREEN_MIN_COVERAGE * 100_000,
      unresolvedRevenueCents: (1 - DEFAULT_GREEN_MIN_COVERAGE) * 100_000,
      attributedSpendCents: 200_000,
      totalSpendCents: 200_000,
      resolvedOrders: 30,
      unresolvedOrders: 5,
    }),
    { greenMinCoverage: null, yellowMinCoverage: null, maxUnresolvedShare: null },
  );
  assert.equal(v.band, "green");
});

// ── Verification #8 — sample floor guards the low-order tail ─────────────────

test(`computeSensorTrust — total orders below MIN_SAMPLE_ORDERS (${MIN_SAMPLE_ORDERS}) → red even when coverage looks great`, () => {
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 100_000,
      unresolvedRevenueCents: 0, // "perfect" coverage 1.0
      attributedSpendCents: 200_000,
      totalSpendCents: 200_000,
      resolvedOrders: MIN_SAMPLE_ORDERS - 1, // one order short of the floor
      unresolvedOrders: 0,
    }),
    thresholds(),
  );
  assert.equal(v.coverageRatio, 1);
  assert.equal(v.band, "red");
  assert.ok(v.reasons.includes("insufficient_sample"));
});

// ── Verification #9 — yellow > green floors get coerced (defensive) ──────────

test("computeSensorTrust — yellow_min_coverage > green_min_coverage is coerced (yellow clamped down)", () => {
  // Author a malformed cohort: yellow floor > green floor. The probe should collapse
  // yellow down to green so there's no impossible band gap. Coverage=0.75 with green=0.7,
  // yellow=0.9 (bad) → yellow gets clamped to 0.7 → coverage 0.75 ≥ green → green (not red).
  const v = computeSensorTrust(
    totals({
      resolvedRevenueCents: 75_000,
      unresolvedRevenueCents: 15_000, // coverage ≈ 0.83
      attributedSpendCents: 200_000,
      totalSpendCents: 200_000,
      resolvedOrders: 30,
      unresolvedOrders: 5,
    }),
    thresholds({ greenMinCoverage: 0.7, yellowMinCoverage: 0.9 }),
  );
  assert.equal(v.band, "green");
});

// ── Verification #10 — defaults are consumed (regression guard) ──────────────

test("computeSensorTrust — DEFAULT_YELLOW_MIN_COVERAGE + DEFAULT_MAX_UNRESOLVED_SHARE are exported non-negative numbers", () => {
  assert.ok(Number.isFinite(DEFAULT_YELLOW_MIN_COVERAGE) && DEFAULT_YELLOW_MIN_COVERAGE >= 0);
  assert.ok(Number.isFinite(DEFAULT_MAX_UNRESOLVED_SHARE) && DEFAULT_MAX_UNRESOLVED_SHARE >= 0);
  assert.ok(DEFAULT_YELLOW_MIN_COVERAGE <= DEFAULT_GREEN_MIN_COVERAGE);
});
