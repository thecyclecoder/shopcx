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

// bianca-cold-test-recent-purchaser-exclusion Phase 2 — exclusion composition
// buildAdsetTemplate layers excludedCustomAudienceIds into the resolved targeting's
// excluded_custom_audiences (Meta's `[{ id }, …]` shape). A caller-supplied targeting that
// already carries an `excluded_custom_audiences` key wins (caller intent respected).

test("buildAdsetTemplate: excludedCustomAudienceIds → composes excluded_custom_audiences on the default targeting", () => {
  const t = buildAdsetTemplate({ pixelId: "PX", excludedCustomAudienceIds: ["23843000000000001"] });
  // Every DEFAULT_TEST_TARGETING field survives the merge.
  const tt = t.targeting as Record<string, unknown>;
  assert.equal(tt.age_min, 50);
  assert.equal(tt.age_max, 65);
  assert.deepEqual(tt.genders, [2]);
  // Meta's exclusion shape: array of `{ id }` objects (NOT bare strings).
  assert.deepEqual(tt.excluded_custom_audiences, [{ id: "23843000000000001" }]);
});

test("buildAdsetTemplate: excludedCustomAudienceIds composes cleanly over a caller-supplied targeting", () => {
  // Caller passes their own targeting (no excluded_custom_audiences of their own) — the
  // exclusion layers on top and every caller field survives.
  const custom = { age_min: 55, age_max: 65, geo_locations: { countries: ["US", "CA"] } };
  const t = buildAdsetTemplate({
    pixelId: "PX",
    targeting: custom,
    excludedCustomAudienceIds: ["23843000000000001"],
  });
  const tt = t.targeting as Record<string, unknown>;
  assert.equal(tt.age_min, 55); // caller
  assert.equal(tt.age_max, 65); // caller
  assert.deepEqual(tt.geo_locations, { countries: ["US", "CA"] }); // caller
  assert.deepEqual(tt.excluded_custom_audiences, [{ id: "23843000000000001" }]);
});

test("buildAdsetTemplate: caller-supplied excluded_custom_audiences WINS over the passed ids (caller intent respected)", () => {
  const customWithExclusion = {
    age_min: 55,
    excluded_custom_audiences: [{ id: "founder-crafted-1" }, { id: "founder-crafted-2" }],
  };
  const t = buildAdsetTemplate({
    pixelId: "PX",
    targeting: customWithExclusion,
    excludedCustomAudienceIds: ["would-be-added"],
  });
  assert.deepEqual(t.targeting.excluded_custom_audiences, [
    { id: "founder-crafted-1" },
    { id: "founder-crafted-2" },
  ]);
});

test("buildAdsetTemplate: no excludedCustomAudienceIds (or empty array) leaves targeting exactly as asked (no empty key added)", () => {
  const t1 = buildAdsetTemplate({ pixelId: "PX" });
  const t2 = buildAdsetTemplate({ pixelId: "PX", excludedCustomAudienceIds: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(t1.targeting, "excluded_custom_audiences"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(t2.targeting, "excluded_custom_audiences"), false);
});

// Regression-pin: DEFAULT_TEST_TARGETING is the F50-65 converter cohort (docs/brain/reference/meta-scaling-methodology.md).
// A stray edit reverting to the old 18-65 / no-gender shape confounds the per-creative CPA read the M4 crown
// depends on — the goal's M1 clean-cold-read fix. If any assertion here fails, DO NOT relax the test; fix the
// constant (or open a spec if the converter cohort has legitimately changed).
test("DEFAULT_TEST_TARGETING: pinned to the F50-65 converter cohort (US women 50-65, home+recent, Advantage+ on)", () => {
  const t = DEFAULT_TEST_TARGETING as {
    age_min: number;
    age_max: number;
    genders: number[];
    geo_locations: { countries: string[]; location_types: string[] };
    targeting_automation: { advantage_audience: number };
  };
  assert.equal(t.age_min, 50);
  assert.equal(t.age_max, 65);
  assert.deepEqual(t.genders, [2]);
  assert.deepEqual(t.geo_locations.countries, ["US"]);
  assert.deepEqual(t.geo_locations.location_types, ["home", "recent"]);
  assert.equal(t.targeting_automation.advantage_audience, 1);
  assert.notEqual(t.age_min, 18); // explicit regression guard against the old default
});
