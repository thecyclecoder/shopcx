/**
 * Pins the Advantage+ age-floor sanitizer (CEO 2026-08-28).
 *
 * The wedge: the Amazing Coffee K-Cups cohort carried a legacy 50-65 older-buyer profile alongside
 * `advantage_audience=1`. Meta refused EVERY mint — ten-plus attempts across Aug 26-27, each a
 * meta_400 leaving `meta_adset_id` null:
 *
 *   "With ad sets that use Advantage+ audience, the minimum age audience control can't be set to
 *    higher than 25: You can add a higher minimum age as a suggestion instead."
 *
 * K-Cups had been unblocked days earlier and a creative was waiting; the cohort read correctly at
 * every layer that was checked, and still could not launch, because the failure was one call
 * further down. Clamping keeps the replenish alive; a throw would reproduce the silent stall.
 *
 * Run: npx tsx --test src/lib/advantage-age-targeting.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeAdvantageAgeTargeting, ADVANTAGE_AUDIENCE_MAX_AGE_MIN } from "./meta-ads";

const withAdvantage = (ageMin: number, ageMax = 65) => ({
  age_min: ageMin,
  age_max: ageMax,
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
});

test("⭐ the exact K-Cups spec Meta refused is clamped to a legal floor", () => {
  const { targeting, clamped } = sanitizeAdvantageAgeTargeting(withAdvantage(50));
  assert.equal(targeting.age_min, 25);
  assert.deepEqual(clamped, { from: 50, to: 25 });
});

test("age_max is untouched — only the FLOOR is capped", () => {
  const { targeting } = sanitizeAdvantageAgeTargeting(withAdvantage(50, 65));
  assert.equal(targeting.age_max, 65, "65 is Meta's top bucket (65+) and is always legal");
});

test("a legal floor passes through byte-identically", () => {
  const spec = withAdvantage(18);
  const { targeting, clamped } = sanitizeAdvantageAgeTargeting(spec);
  assert.equal(clamped, null);
  assert.equal(targeting, spec, "an untouched spec must be the SAME object — no needless churn");
});

test("exactly at the cap is legal and untouched", () => {
  const { clamped } = sanitizeAdvantageAgeTargeting(withAdvantage(ADVANTAGE_AUDIENCE_MAX_AGE_MIN));
  assert.equal(clamped, null);
});

test("one over the cap is clamped", () => {
  const { targeting, clamped } = sanitizeAdvantageAgeTargeting(withAdvantage(ADVANTAGE_AUDIENCE_MAX_AGE_MIN + 1));
  assert.equal(targeting.age_min, ADVANTAGE_AUDIENCE_MAX_AGE_MIN);
  assert.ok(clamped);
});

test("WITHOUT Advantage+ a high floor is legitimate and must NOT be clamped", () => {
  // Meta only caps the floor when the automation is on. Clamping here would silently destroy a
  // deliberate older-demographic test on a manually-targeted ad set.
  const spec = { age_min: 50, age_max: 65, targeting_automation: { advantage_audience: 0 } };
  const { targeting, clamped } = sanitizeAdvantageAgeTargeting(spec);
  assert.equal(clamped, null);
  assert.equal(targeting.age_min, 50);
});

test("no targeting_automation block at all ⇒ untouched", () => {
  const spec = { age_min: 55, age_max: 65 };
  const { clamped } = sanitizeAdvantageAgeTargeting(spec);
  assert.equal(clamped, null);
});

test("a missing or non-numeric age_min is left alone rather than invented", () => {
  for (const bad of [undefined, null, "fifty", Number.NaN]) {
    const { clamped } = sanitizeAdvantageAgeTargeting({ age_min: bad, targeting_automation: { advantage_audience: 1 } });
    assert.equal(clamped, null);
  }
});

test("the input spec is never mutated", () => {
  const spec = withAdvantage(50);
  sanitizeAdvantageAgeTargeting(spec);
  assert.equal(spec.age_min, 50, "the caller's object must survive unchanged");
});

test("every other field survives the clamp", () => {
  const { targeting } = sanitizeAdvantageAgeTargeting({
    ...withAdvantage(50),
    excluded_custom_audiences: [{ id: "aud-1" }, { id: "aud-2" }],
  });
  assert.deepEqual(targeting.excluded_custom_audiences, [{ id: "aud-1" }, { id: "aud-2" }]);
  assert.deepEqual(targeting.geo_locations, { countries: ["US"], location_types: ["home", "recent"] });
  assert.deepEqual(targeting.targeting_automation, { advantage_audience: 1 });
});
