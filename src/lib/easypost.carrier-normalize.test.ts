/**
 * Pins the OSM carrier-mapping fix for order-tracking's live EasyPost read.
 *
 * Ground truth: ticket ddf7a03d (order SC141273), an OSM Worldwide shipment whose
 * fulfillment carrier label is "OSM Priority Select". EasyPost rejects that raw
 * string ("The carrier you have provided is not supported by EasyPost"), so the live
 * tracker read failed and order-tracking fell back to a stale "available within 24
 * hours" reply even though the order already carried a usable tracking URL + number.
 * `normalizeTrackingCarrier` maps every OSM label to EasyPost's "OSM" carrier so the
 * read succeeds; an empty carrier returns undefined so EasyPost auto-detects.
 *
 * Run: npx tsx --test src/lib/easypost.carrier-normalize.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrackingCarrier } from "./easypost";

test("OSM Priority Select normalizes to the EasyPost OSM carrier", () => {
  assert.equal(normalizeTrackingCarrier("OSM Priority Select"), "OSM");
});

test("every OSM label normalizes to OSM, case-insensitively", () => {
  assert.equal(normalizeTrackingCarrier("OSM Worldwide"), "OSM");
  assert.equal(normalizeTrackingCarrier("osm worldwide"), "OSM");
  assert.equal(normalizeTrackingCarrier("OSMWorldwide"), "OSM");
  assert.equal(normalizeTrackingCarrier("OSM"), "OSM");
  assert.equal(normalizeTrackingCarrier(" osm priority select "), "OSM");
});

test("known carriers pass through unchanged (trimmed)", () => {
  assert.equal(normalizeTrackingCarrier("USPS"), "USPS");
  assert.equal(normalizeTrackingCarrier(" UPS "), "UPS");
  assert.equal(normalizeTrackingCarrier("FedEx"), "FedEx");
});

test("empty/null/undefined carrier returns undefined so EasyPost auto-detects", () => {
  assert.equal(normalizeTrackingCarrier(""), undefined);
  assert.equal(normalizeTrackingCarrier("   "), undefined);
  assert.equal(normalizeTrackingCarrier(null), undefined);
  assert.equal(normalizeTrackingCarrier(undefined), undefined);
});
