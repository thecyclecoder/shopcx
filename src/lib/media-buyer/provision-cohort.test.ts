/**
 * Unit tests for the per-test-adset cohort math + template (pure parts of provision-cohort).
 * Run: npx tsx --test src/lib/media-buyer/provision-cohort.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { maxConcurrentTests, buildAdsetTemplate, DEFAULT_TEST_TARGETING } from "./provision-cohort";

test("maxConcurrentTests: $600 ceiling / $150 per test = 4 slots", () => {
  assert.equal(maxConcurrentTests({ daily_test_ceiling_cents: 60000, per_test_daily_budget_cents: 15000 }), 4);
});

test("maxConcurrentTests: floors partial slots ($500/$150 = 3)", () => {
  assert.equal(maxConcurrentTests({ daily_test_ceiling_cents: 50000, per_test_daily_budget_cents: 15000 }), 3);
});

test("maxConcurrentTests: never below 1, and guards a 0/absent per-test budget", () => {
  assert.equal(maxConcurrentTests({ daily_test_ceiling_cents: 10000, per_test_daily_budget_cents: 15000 }), 1);
  assert.equal(maxConcurrentTests({ daily_test_ceiling_cents: 60000, per_test_daily_budget_cents: 0 }), 4); // falls back to $150
});

test("buildAdsetTemplate: purchase-optimized ABO defaults + the passed pixel", () => {
  const t = buildAdsetTemplate({ pixelId: "PX123" });
  assert.equal(t.optimizationGoal, "OFFSITE_CONVERSIONS");
  assert.equal(t.customEventType, "PURCHASE");
  assert.equal(t.pixelId, "PX123");
  assert.deepEqual(t.targeting, DEFAULT_TEST_TARGETING);
});

test("buildAdsetTemplate: caller targeting overrides the default", () => {
  const custom = { age_min: 50, age_max: 65, geo_locations: { countries: ["US"] } };
  assert.deepEqual(buildAdsetTemplate({ pixelId: "PX", targeting: custom }).targeting, custom);
});
