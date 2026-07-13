/**
 * testing-results-sdk — the pure crown→dud tiering + sort. Guards the verdict boundaries against the
 * SSOT setpoints (crown ≥N purch @ CAC ≤ crown @ ≥ crown-spend · hold band · deadline · early trim).
 *   npx tsx --test src/lib/ads/testing-results-sdk.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tierForTest, compareTests, type TestThresholds, type TestAdsetRow } from "./testing-results-sdk";

const T: TestThresholds = {
  crownMaxCpaCents: 15000, crownMinSpendCents: 45000, crownMinPurchases: 8,
  holdBandMaxCpaCents: 22000, maxTestSpendCents: 120000, earlyTrimMinSpendCents: 30000,
};

test("crown requires all three: ≥8 purchases AND CAC ≤ $150 AND spend ≥ $450", () => {
  // 8 purch, $1000 spend → CAC $125 ≤ $150 → crown
  assert.equal(tierForTest({ spendCents: 100000, purchases: 8, addToCart: 20 }, T), "crown");
  // great CAC + spend but only 7 purchases → NOT crown (falls to promising: CAC ≤ hold band)
  assert.equal(tierForTest({ spendCents: 70000, purchases: 7, addToCart: 20 }, T), "promising");
  // 8 purchases but CAC $200 (> $150 crown, ≤ $220 hold) → promising, not crown
  assert.equal(tierForTest({ spendCents: 160000, purchases: 8, addToCart: 20 }, T), "promising");
});

test("promising = converting within the hold band (CAC ≤ $220), any spend", () => {
  assert.equal(tierForTest({ spendCents: 20000, purchases: 1, addToCart: 3 }, T), "promising"); // CAC $200
  assert.equal(tierForTest({ spendCents: 5400, purchases: 1, addToCart: 1 }, T), "promising"); // CAC $54
});

test("early dud = spend ≥ $300 with 0 sales", () => {
  assert.equal(tierForTest({ spendCents: 30000, purchases: 0, addToCart: 2 }, T), "dud");
  // under the early-trim floor with 0 sales → still testing (not enough spend to judge)
  assert.equal(tierForTest({ spendCents: 25000, purchases: 0, addToCart: 1 }, T), "testing");
});

test("deadline dud = past $1,200 without reaching the hold band", () => {
  // $1300 spend, 1 sale → CAC $1300 > hold band → dud
  assert.equal(tierForTest({ spendCents: 130000, purchases: 1, addToCart: 5 }, T), "dud");
});

test("testing = early / converting-but-above-hold at low spend", () => {
  assert.equal(tierForTest({ spendCents: 10000, purchases: 0, addToCart: 1 }, T), "testing");
  // 1 sale at CAC $300 but low spend (not past deadline) → testing, not dud
  assert.equal(tierForTest({ spendCents: 30000, purchases: 1, addToCart: 2 }, T), "testing");
});

const mk = (over: Partial<TestAdsetRow>): TestAdsetRow => ({
  productId: "p", productTitle: "P", metaAccountId: "1", metaAccountName: "A", campaignId: "c",
  adsetId: "a", adsetName: "n", effectiveStatus: "ACTIVE", active: true,
  spendCents: 0, impressions: 0, clicks: 0, addToCart: 0, purchases: 0, revenueCents: 0,
  cpmCents: 0, ctrPct: 0, costPerAtcCents: null, cacCents: null, tier: "testing",
  lastDataDate: null, creative: null, ...over,
});

test("compareTests orders crown → promising → testing → dud, then by purchases", () => {
  const crown = mk({ tier: "crown", purchases: 10 });
  const promising = mk({ tier: "promising", purchases: 2 });
  const testing = mk({ tier: "testing", purchases: 0 });
  const dud = mk({ tier: "dud", purchases: 0 });
  const sorted = [dud, testing, crown, promising].sort(compareTests);
  assert.deepEqual(sorted.map((r) => r.tier), ["crown", "promising", "testing", "dud"]);
});

test("within a tier, more purchases then lower CAC ranks first", () => {
  const a = mk({ tier: "promising", purchases: 3, cacCents: 12000 });
  const b = mk({ tier: "promising", purchases: 5, cacCents: 20000 });
  const c = mk({ tier: "promising", purchases: 5, cacCents: 10000 });
  const sorted = [a, b, c].sort(compareTests);
  assert.deepEqual([sorted[0].purchases, sorted[0].cacCents], [5, 10000]); // most purch, lowest CAC
  assert.equal(sorted[2].purchases, 3);
});
