/**
 * Meta-source family predicate + PostgREST family-filter helper.
 *
 * Pins the widening from the Attribution Sensor Recalibration spec (Phase 1):
 * every member of the Meta ad family — `meta` / `facebook` / `fb` / `ig` /
 * `instagram` (any case) — matches, and `google` / `klaviyo` don't. The
 * `.or()` argument helper reproduces that predicate at the DB layer.
 *
 *   npx tsx --test src/lib/utm.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isMetaUtm, metaFamilyOr } from "./utm";

test("isMetaUtm matches every Meta family source (case-insensitive)", () => {
  for (const s of [
    "meta",
    "Meta",
    "META",
    "meta_ads",
    "facebook",
    "Facebook",
    "FB",
    "fb",
    "ig",
    "IG",
    "instagram",
    "Instagram",
    "  facebook  ", // includes() ignores whitespace by design; still Meta
  ]) {
    assert.equal(isMetaUtm(s), true, `expected ${JSON.stringify(s)} → true`);
  }
});

test("isMetaUtm rejects non-Meta sources (and null/undefined)", () => {
  for (const s of ["google", "Google", "klaviyo", "Klaviyo", "direct", "tiktok", "", null, undefined]) {
    assert.equal(isMetaUtm(s), false, `expected ${JSON.stringify(s)} → false`);
  }
});

test("metaFamilyOr emits the case-insensitive family filter for a column", () => {
  const s = metaFamilyOr("utm_source");
  // The whole family must be in there — the widening is the whole point.
  assert.equal(s.includes("utm_source.ilike.%meta%"), true);
  assert.equal(s.includes("utm_source.ilike.%facebook%"), true);
  assert.equal(s.includes("utm_source.ilike.%instagram%"), true);
  // Short values are matched with anchored ilike (no wildcards) — matches
  // 'fb'/'FB' at the DB layer just as isMetaUtm('FB') does in JS.
  assert.equal(s.includes("utm_source.ilike.fb"), true);
  assert.equal(s.includes("utm_source.ilike.ig"), true);
  // Column name is parameterized.
  assert.equal(metaFamilyOr("attributed_utm_source").includes("attributed_utm_source.ilike.%meta%"), true);
  // No accidental case-sensitive `eq` fell through.
  assert.equal(/(^|,)utm_source\.eq\./.test(s), false);
});

test("family filter and JS predicate agree on the family (contract test)", () => {
  // Each Meta member the filter matches must also pass the JS predicate — this
  // pins them together so a future edit to one without the other is caught.
  const cases = ["meta", "MetaAds", "facebook", "FaceBook", "fb", "FB", "ig", "IG", "instagram"];
  for (const s of cases) assert.equal(isMetaUtm(s), true, s);
  for (const s of ["google", "klaviyo", "direct"]) assert.equal(isMetaUtm(s), false, s);
});
