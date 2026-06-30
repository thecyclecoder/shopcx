/**
 * Unit tests for `assembleGrowthReportContract` (Phase 2 of
 * docs/brain/specs/growth-blended-cac-ltv-objective.md). The pure assembler lets us pin the wiring
 * (blended top-line row first, payback row second, per-product rows after, COGS-deferred assumption
 * appended, health from blended) on fixture inputs without a database.
 *
 * Built-in node:test — run:
 *   npm run test:growth-report-contract
 *   (= tsx --test src/lib/growth-report-contract.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleGrowthReportContract,
  DEFAULT_ACQ_ROAS_TARGET,
  type LinePass,
} from "./growth-report-contract";
import {
  blendedCacLtvFromTotals,
  DEFAULT_BLENDED_CAC_LTV_TARGET,
  type BlendedCacLtvResult,
} from "./blended-cac-ltv";
import {
  validateDirectorReportContract,
} from "./ceo-mode/director-report-contract";
import type { AcqRoasResult } from "./acquisition-roas";

const W_START = "2026-06-01";
const W_END = "2026-06-30";

function acq(overrides: Partial<AcqRoasResult> & { groupId: string }): AcqRoasResult {
  const base: AcqRoasResult = {
    workspaceId: "ws-1",
    groupId: overrides.groupId,
    groupName: overrides.groupName ?? `Group ${overrides.groupId}`,
    startDate: W_START,
    endDate: W_END,
    productIds: [],
    acqRoas: 2.5,
    numeratorCents: 10_000_00,
    channelSplit: { onsiteCents: 6_000_00, amazonCents: 4_000_00, spendCents: 4_000_00 },
    haloRatio: 0.67,
    accounts: [],
    assumptions: { creditAmazonToMeta: true, countAllNonRenewal: true, sharedAccountFloor: false },
    flags: [],
  };
  return { ...base, ...overrides };
}

function blendedHealthy(): BlendedCacLtvResult {
  // 100 customers @ $50 CAC, $200 LTV → 4× (above DEFAULT target 3×).
  return blendedCacLtvFromTotals({
    blendedSpendCents: 5_000_00,
    blendedRevenueCents: 8_000_00,
    blendedNewCustomers: 100,
    blendedLtvCents: 200_00,
    windowDays: 30,
    creditAmazonHalo: true,
    countAllNonRenewal: true,
  });
}

function blendedBelowTarget(): BlendedCacLtvResult {
  // CAC $50, LTV $100 → 2× (below DEFAULT target 3×).
  return blendedCacLtvFromTotals({
    blendedSpendCents: 5_000_00,
    blendedRevenueCents: 8_000_00,
    blendedNewCustomers: 100,
    blendedLtvCents: 100_00,
    windowDays: 30,
    creditAmazonHalo: true,
    countAllNonRenewal: true,
  });
}

function blendedNullRatio(): BlendedCacLtvResult {
  return blendedCacLtvFromTotals({
    blendedSpendCents: 0,
    blendedRevenueCents: 0,
    blendedNewCustomers: 0,
    blendedLtvCents: 0,
    windowDays: 30,
    creditAmazonHalo: true,
    countAllNonRenewal: true,
  });
}

const baseInput = {
  startDate: W_START,
  endDate: W_END,
  passes: [
    { current: acq({ groupId: "g1", groupName: "Amazing Coffee" }), prior: null },
  ] as LinePass[],
  blendedPrior: null,
  targetAcqRoas: DEFAULT_ACQ_ROAS_TARGET,
  targetCacLtv: DEFAULT_BLENDED_CAC_LTV_TARGET,
  targetPaybackDays: null as number | null,
  noMappedGroups: false,
};

test("contract validates AND metrics[0].key === 'blended_cac_ltv' (top-line first)", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedHealthy() });

  const { valid, errors } = validateDirectorReportContract(contract);
  assert.equal(valid, true, `expected valid contract, got errors: ${JSON.stringify(errors)}`);
  assert.equal(contract.metrics_vs_target[0].key, "blended_cac_ltv");
  assert.equal(contract.metrics_vs_target[0].metric, "Blended CAC:LTV");
  assert.equal(contract.metrics_vs_target[0].value, 4);
  assert.equal(contract.metrics_vs_target[0].target, DEFAULT_BLENDED_CAC_LTV_TARGET);
  assert.equal(contract.metrics_vs_target[0].status, "above");
});

test("metrics[1] is the secondary blended_payback_days row (lower is better)", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedHealthy() });

  assert.equal(contract.metrics_vs_target[1].key, "blended_payback_days");
  assert.equal(contract.metrics_vs_target[1].unit, "days");
  assert.match(contract.metrics_vs_target[1].note ?? "", /lower is better/);
  // payback computed by the Phase-1 helper = round(spend × windowDays / revenue) = round(5000_00*30/8000_00)=19
  assert.equal(contract.metrics_vs_target[1].value, 19);
  assert.equal(contract.metrics_vs_target[1].target, null);
  assert.equal(contract.metrics_vs_target[1].status, "unknown");
});

test("per-product AcqROAS rows come AFTER the two blended rows", () => {
  const contract = assembleGrowthReportContract({
    ...baseInput,
    blendedCurrent: blendedHealthy(),
    passes: [
      { current: acq({ groupId: "g1", groupName: "Amazing Coffee" }), prior: null },
      { current: acq({ groupId: "g2", groupName: "Beauty Beverage" }), prior: null },
    ],
  });

  assert.equal(contract.metrics_vs_target.length, 4);
  assert.equal(contract.metrics_vs_target[2].metric, "AcqROAS — Amazing Coffee");
  assert.equal(contract.metrics_vs_target[3].metric, "AcqROAS — Beauty Beverage");
});

test("contract.assumptions includes the COGS-deferred line and the LTV-uncalibrated line", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedHealthy() });

  const joined = (contract.assumptions ?? []).join("\n");
  assert.match(joined, /COGS/);
  assert.match(joined, /marginRoasBlockedOnCogs=true/);
  assert.match(joined, /ltvProxyUncalibrated=true/);
  assert.match(joined, /paybackUsesWindowRateExtrapolation=true/);
});

test("contract.proxy is 'blended_cac_ltv' (the bounded proxy the Director reasons on)", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedHealthy() });
  assert.equal(contract.proxy, "blended_cac_ltv");
});

test("week-over-week delta surfaces on the blended row when a prior is provided", () => {
  const current = blendedHealthy(); // ratio 4
  const prior = blendedBelowTarget(); // ratio 2
  const contract = assembleGrowthReportContract({
    ...baseInput,
    blendedCurrent: current,
    blendedPrior: prior,
  });
  assert.equal(contract.metrics_vs_target[0].delta, 2);
});

test("health_score reflects blended target attainment (100 when above target)", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedHealthy() });
  assert.equal(contract.health_score, 100); // 4 / 3 clamped to 1 → 100
});

test("health_score drops proportionally when blended is below target", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedBelowTarget() });
  // ratio 2, target 3 → 2/3 → round(66.66…) = 67
  assert.equal(contract.health_score, 67);
});

test("health_score is the neutral 50 when blended cacLtvRatio is null", () => {
  const contract = assembleGrowthReportContract({ ...baseInput, blendedCurrent: blendedNullRatio() });
  assert.equal(contract.health_score, 50);
});

test("noMappedGroups=true emits the no-mapping watch finding", () => {
  const contract = assembleGrowthReportContract({
    ...baseInput,
    blendedCurrent: blendedNullRatio(),
    passes: [],
    noMappedGroups: true,
  });
  assert.ok(
    contract.findings.some((f) => f.summary.includes("No product line") && f.severity === "watch"),
    `expected the no-mapping watch finding; got: ${JSON.stringify(contract.findings)}`,
  );
});

test("explicit targetPaybackDays surfaces on the payback row and drives its status", () => {
  const contract = assembleGrowthReportContract({
    ...baseInput,
    blendedCurrent: blendedHealthy(), // paybackDays=19
    targetPaybackDays: 30,
  });
  assert.equal(contract.metrics_vs_target[1].target, 30);
  // 19 < 30 → status "below" (lower-is-better, but the contract uses direction-agnostic compare;
  // the `note` warns the reader)
  assert.equal(contract.metrics_vs_target[1].status, "below");
});
