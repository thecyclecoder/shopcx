/**
 * Pins the pure math behind the Analytics → Profit page.
 *
 * The wedge is July 2026: the retired hardcoded model (COGS 17% / shipping 15% /
 * discounts 12% / Shopify-tx 3% / Amazon-fee 25% / G&A $54,542, Meta-only ads)
 * reported $46,065 against a real QuickBooks adjusted net income of $65,458.
 * These tests pin that the calibrated model reproduces the real number from
 * July's own actuals, and that the two profit lines never drift apart.
 *
 * Run: npx tsx --test src/lib/profit-estimate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProfitLines,
  deriveCalibration,
  projectRenewalRevenue,
  projectFromRunRate,
  lastClosedMonths,
  monthStart,
  monthEnd,
  daysInMonth,
  previousDay,
  FALLBACK_CALIBRATION,
  type CalibrationInput,
} from "./profit-estimate";

// July 2026 actuals, from qb_pnl_snapshots + our own daily snapshots.
const JULY: CalibrationInput = {
  periodMonth: "2026-07-01",
  totalIncome: 248419.83,
  totalCogs: 68110.91,
  transactionFees: 15569.99,
  digitalAdvertising: 38890.53,
  fixedOpex: 58985.25,
  managementFees: 60000,
  netOperatingIncome: 66863.15,
  adjustedNetIncome: 65457.86,
  internalGross: 274481,
  metaSpend: 41184,
};

test("deriveCalibration turns one closed month into its own ratios", () => {
  const cal = deriveCalibration([JULY], 0.7);
  assert.ok(Math.abs(cal.incomeRatio - 248419.83 / 274481) < 1e-9);
  assert.ok(Math.abs(cal.cogsRatio - 68110.91 / 248419.83) < 1e-9);
  assert.ok(Math.abs(cal.txnFeeRatio - 15569.99 / 248419.83) < 1e-9);
  assert.ok(Math.abs(cal.adSpendRatio - 38890.53 / 41184) < 1e-9);
  assert.equal(cal.fixedOpexCents, 5898525);
  assert.equal(cal.managementFeesCents, 6000000);
  assert.equal(cal.renewalCollectionRate, 0.7);
  assert.deepEqual(cal.monthsUsed, ["2026-07-01"]);
});

test("July's own actuals reproduce July's real profit within 1%", () => {
  const cal = deriveCalibration([JULY], 0.7);
  const lines = computeProfitLines(
    Math.round(JULY.internalGross * 100),
    Math.round(JULY.metaSpend * 100),
    cal,
  );
  // Income must land on QBO's total_income exactly (that's what incomeRatio encodes).
  assert.ok(Math.abs(lines.incomeCents - 24841983) <= 1, `income ${lines.incomeCents}`);
  // Real profit must land on QBO's adjusted_net_income.
  const realDollars = lines.adjustedNetIncomeCents / 100;
  assert.ok(
    Math.abs(realDollars - 65457.86) / 65457.86 < 0.01,
    `real profit ${realDollars} vs 65457.86`,
  );
  // And the retired hardcoded model's answer is NOT what we produce.
  assert.ok(Math.abs(realDollars - 46065) > 15000, "must not reproduce the old hardcoded $46K");
});

test("the two profit lines differ by exactly the management fee", () => {
  const cal = deriveCalibration([JULY], 0.7);
  const lines = computeProfitLines(27448100, 4118400, cal);
  assert.equal(
    lines.adjustedNetIncomeCents - lines.netIncomeCents,
    lines.managementFeesCents,
    "adjusted − booked must equal the addback",
  );
});

test("a month with no management fee makes the addback a no-op", () => {
  const noFee: CalibrationInput = { ...JULY, managementFees: null };
  const cal = deriveCalibration([noFee], 0.7);
  assert.equal(cal.managementFeesCents, 0);
  const lines = computeProfitLines(27448100, 4118400, cal);
  assert.equal(lines.netIncomeCents, lines.adjustedNetIncomeCents);
});

test("deriveCalibration averages ratios per-month, not from summed totals", () => {
  const big: CalibrationInput = { ...JULY, periodMonth: "2026-06-01", totalIncome: 500000, internalGross: 1000000 };
  const cal = deriveCalibration([JULY, big], 0.7);
  const perMonthMean = (248419.83 / 274481 + 0.5) / 2;
  assert.ok(Math.abs(cal.incomeRatio - perMonthMean) < 1e-9, "must be the mean of ratios");
  const fromTotals = (248419.83 + 500000) / (274481 + 1000000);
  assert.ok(Math.abs(cal.incomeRatio - fromTotals) > 1e-6, "must NOT be ratio of sums");
});

test("no closed months falls back to defaults but keeps the observed renewal rate", () => {
  const cal = deriveCalibration([], 0.63);
  assert.equal(cal.incomeRatio, FALLBACK_CALIBRATION.incomeRatio);
  assert.equal(cal.renewalCollectionRate, 0.63);
  assert.deepEqual(cal.monthsUsed, []);
});

test("renewals project off the scheduled book, not a run rate", () => {
  // $130,400 already collected, $36,728 still scheduled, 72% historically collects.
  assert.equal(projectRenewalRevenue(13040000, 3672800, 0.72), 13040000 + Math.round(3672800 * 0.72));
  // An empty forward book means the month is already fully realized.
  assert.equal(projectRenewalRevenue(13040000, 0, 0.72), 13040000);
  // A 100% collection rate adds the book untouched.
  assert.equal(projectRenewalRevenue(0, 5000, 1), 5000);
});

test("run-rate projection extrapolates complete days only", () => {
  // $23 over 23 days = $1/day → 31 days = $31.
  assert.equal(projectFromRunRate(2300, 23, 31), 3100);
  // A complete month is returned untouched.
  assert.equal(projectFromRunRate(2300, 31, 31), 2300);
  // No complete days yet → nothing to extrapolate from.
  assert.equal(projectFromRunRate(500, 0, 31), 0);
});

test("date helpers bracket the month in Central terms", () => {
  assert.equal(monthStart("2026-08-24"), "2026-08-01");
  assert.equal(monthEnd("2026-08-24"), "2026-08-31");
  assert.equal(monthEnd("2026-02-10"), "2026-02-28");
  assert.equal(daysInMonth("2026-08-24"), 31);
  assert.equal(daysInMonth("2026-02-10"), 28);
  assert.equal(previousDay("2026-08-01"), "2026-07-31");
  assert.equal(previousDay("2026-08-24"), "2026-08-23");
});

test("lastClosedMonths excludes the in-progress month", () => {
  assert.deepEqual(lastClosedMonths(3, "2026-08-24"), ["2026-05-01", "2026-06-01", "2026-07-01"]);
  // Year boundary.
  assert.deepEqual(lastClosedMonths(2, "2026-01-15"), ["2025-11-01", "2025-12-01"]);
  assert.deepEqual(lastClosedMonths(1, "2026-08-24"), ["2026-07-01"]);
});
