/**
 * Pins the pure half of [[pack-dimensions]] — the parts that decide what number reaches the ad
 * render prompt. Every case below is a real shape observed on our own catalog on 2026-08-17.
 *
 * Runs via: npx tsx --test src/lib/amazon/pack-dimensions.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  measureToMm,
  toStandingPouchMm,
  selectConsensusDimensions,
  isSelfContradictory,
  type PackDimensionCandidate,
} from "./pack-dimensions";

test("measureToMm converts inches and refuses an unknown unit", () => {
  assert.equal(Math.round(measureToMm({ unit: "inches", value: 9.65 })!), 245);
  assert.equal(measureToMm({ unit: "mm", value: 198 }), 198);
  assert.equal(measureToMm({ unit: "cm", value: 19.8 }), 198);
  // A wrong unit is a 25x error in the prompt — never guess.
  assert.equal(measureToMm({ unit: "furlongs", value: 3 }), null);
  assert.equal(measureToMm({ value: 3 }), null);
  assert.equal(measureToMm({ unit: "inches", value: 0 }), null);
  assert.equal(measureToMm(null), null);
});

test("toStandingPouchMm sorts axes rather than trusting Amazon's labels", () => {
  // B08C47SJ5B as reported: 'height' 2.13 is really the gusset, 'length' 9.65 the standing height.
  const got = toStandingPouchMm({
    height: { unit: "inches", value: 2.13 },
    length: { unit: "inches", value: 9.65 },
    width: { unit: "inches", value: 7.8 },
  });
  assert.deepEqual(got, { heightMm: 245, widthMm: 198, depthMm: 54 });
});

test("toStandingPouchMm needs all three axes", () => {
  assert.equal(toStandingPouchMm({ height: { unit: "inches", value: 2 } }), null);
  assert.equal(toStandingPouchMm(null), null);
});

test("isSelfContradictory catches an item larger than its own package (B08KYMN52M)", () => {
  const item = { widthMm: 178, heightMm: 235, depthMm: 69 };
  const pkg = { widthMm: 149, heightMm: 197, depthMm: 67 };
  assert.equal(isSelfContradictory(item, pkg), true);
  assert.equal(isSelfContradictory(pkg, item), false);
  assert.equal(isSelfContradictory(null, pkg), false);
});

test("selectConsensusDimensions outvotes a lone disagreeing child", () => {
  const candidates: PackDimensionCandidate[] = [
    { asin: "B08C47SJ5B", source: "package", widthMm: 198, heightMm: 245, depthMm: 54 },
    { asin: "B0BV4XY3L7", source: "package", widthMm: 199, heightMm: 246, depthMm: 51 },
    { asin: "ODDBALL", source: "item", widthMm: 90, heightMm: 120, depthMm: 40 },
  ];
  const got = selectConsensusDimensions(candidates)!;
  assert.equal(got.agreedWith.length, 2);
  assert.deepEqual(
    got.agreedWith.map((c) => c.asin).sort(),
    ["B08C47SJ5B", "B0BV4XY3L7"],
  );
  // Median of the agreeing pair — the outlier never moves the number.
  assert.equal(got.chosen.widthMm, 199);
  assert.equal(got.chosen.heightMm, 246);
});

test("selectConsensusDimensions returns a lone reading rather than nothing", () => {
  const got = selectConsensusDimensions([
    { asin: "ONLY", source: "item", widthMm: 198, heightMm: 245, depthMm: 53 },
  ])!;
  assert.equal(got.agreedWith.length, 1);
  assert.deepEqual(got.chosen, { widthMm: 198, heightMm: 245, depthMm: 53 });
});

test("selectConsensusDimensions on an empty list is null, never a guess", () => {
  assert.equal(selectConsensusDimensions([]), null);
});
