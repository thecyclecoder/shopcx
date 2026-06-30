/**
 * Unit tests for the blended new-customer CAC↔LTV objective composer (Phase 1 of
 * docs/brain/specs/growth-blended-cac-ltv-objective.md). Pins the math in `blendedCacLtvFromTotals`
 * against fixture totals so no database connection is needed.
 *
 * Built-in node:test — run:
 *   npm run test:blended-cac-ltv
 *   (= tsx --test src/lib/blended-cac-ltv.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BLENDED_CAC_LTV_TARGET,
  blendedCacLtvFromTotals,
  type BlendedCacLtvTotals,
} from "./blended-cac-ltv";

const baseTotals = (overrides: Partial<BlendedCacLtvTotals> = {}): BlendedCacLtvTotals => ({
  // 100 new customers @ $50 CAC ($50_00 cents); LTV $200 → cacLtvRatio = 4.0×
  blendedSpendCents: 5_000_00,
  // $80 per customer average non-renewal revenue captured in the window
  blendedRevenueCents: 8_000_00,
  blendedNewCustomers: 100,
  blendedLtvCents: 200_00,
  // 30-day window → payback = spend × windowDays / revenue = 5000_00 × 30 / 8000_00 = 18.75 → 19
  windowDays: 30,
  creditAmazonHalo: true,
  countAllNonRenewal: true,
  ...overrides,
});

test("fixture totals → expected cacLtvRatio and paybackDays", () => {
  const r = blendedCacLtvFromTotals(baseTotals());

  // CAC = 5000_00 / 100 = 50_00 ; LTV = 200_00 ; ratio = 4.0
  assert.equal(r.cacLtvRatio, 4);

  // payback = round(5000_00 × 30 / 8000_00) = round(18.75) = 19
  assert.equal(r.paybackDays, 19);

  assert.equal(r.blendedSpendCents, 5_000_00);
  assert.equal(r.blendedRevenueCents, 8_000_00);
  assert.equal(r.blendedNewCustomers, 100);
  assert.equal(r.blendedLtvCents, 200_00);
});

test("assumptions: marginRoasBlockedOnCogs + ltvProxyUncalibrated always present", () => {
  const r = blendedCacLtvFromTotals(baseTotals());
  assert.equal(r.assumptions.marginRoasBlockedOnCogs, true);
  assert.equal(r.assumptions.ltvProxyUncalibrated, true);
  assert.equal(r.assumptions.paybackUsesWindowRateExtrapolation, true);
});

test("default target falls through to DEFAULT_BLENDED_CAC_LTV_TARGET (3×)", () => {
  const r = blendedCacLtvFromTotals(baseTotals());
  assert.equal(r.assumptions.targetCacLtv, DEFAULT_BLENDED_CAC_LTV_TARGET);
  assert.equal(r.assumptions.targetCacLtv, 3);
  assert.equal(r.assumptions.targetPaybackDays, null);
});

test("explicit setpoints flow onto assumptions", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ targetCacLtv: 2.5, targetPaybackDays: 14 }));
  assert.equal(r.assumptions.targetCacLtv, 2.5);
  assert.equal(r.assumptions.targetPaybackDays, 14);
});

test("zero new customers ⇒ cacLtvRatio=null + flag", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ blendedNewCustomers: 0, blendedRevenueCents: 0 }));
  assert.equal(r.cacLtvRatio, null);
  assert.ok(
    r.flags.some((f) => f.includes("no new customers")),
    `expected "no new customers" flag, got: ${JSON.stringify(r.flags)}`,
  );
});

test("zero revenue ⇒ paybackDays=null + flag", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ blendedRevenueCents: 0 }));
  assert.equal(r.paybackDays, null);
});

test("zero LTV ⇒ cacLtvRatio=null + flag", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ blendedLtvCents: 0 }));
  assert.equal(r.cacLtvRatio, null);
  assert.ok(
    r.flags.some((f) => f.toLowerCase().includes("ltv proxy returned 0")),
    `expected LTV-zero flag, got: ${JSON.stringify(r.flags)}`,
  );
});

test("zero spend ⇒ cacLtvRatio=null + spend flag", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ blendedSpendCents: 0 }));
  assert.equal(r.cacLtvRatio, null);
  assert.ok(
    r.flags.some((f) => f.toLowerCase().includes("zero mapped meta spend")),
    `expected zero-spend flag, got: ${JSON.stringify(r.flags)}`,
  );
});

test("creditAmazonHalo + countAllNonRenewal echo through to assumptions", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ creditAmazonHalo: false, countAllNonRenewal: false }));
  assert.equal(r.assumptions.creditAmazonHalo, false);
  assert.equal(r.assumptions.countAllNonRenewal, false);
});

test("extraFlags are preserved on the result", () => {
  const r = blendedCacLtvFromTotals(baseTotals({ extraFlags: ["mixed Amazon-halo credit across product lines"] }));
  assert.ok(r.flags.includes("mixed Amazon-halo credit across product lines"));
});

test("cacLtvRatio rounds to 2 decimals", () => {
  // LTV 100_00 ; CAC 30_00 ; ratio = 3.333… → 3.33
  const r = blendedCacLtvFromTotals(
    baseTotals({ blendedSpendCents: 3_000_00, blendedNewCustomers: 100, blendedLtvCents: 100_00 }),
  );
  assert.equal(r.cacLtvRatio, 3.33);
});
