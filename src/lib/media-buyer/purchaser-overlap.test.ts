/**
 * Unit tests for the purchaser-overlap classifier — Phase 2 verification
 * ([[../../../docs/brain/specs/bianca-measure-cold-test-purchaser-overlap]]).
 *
 * Pins the goal's 15% threshold (verify-scale-numbers rule from
 * [[../../../docs/brain/goals/bianca-temperature-aware-campaign-structure]]
 * M2) on the PURE `classifyPurchaserOverlap` seam. If the M2 exclusion
 * build ever drifts off the number the CEO greenlit, one of these pins
 * fails deterministically.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/purchaser-overlap.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPurchaserOverlap,
  PURCHASER_OVERLAP_DEFAULT_THRESHOLD,
} from "./purchaser-overlap";

test("classifyPurchaserOverlap — 0.14 overlap defers (below 15% threshold)", () => {
  assert.equal(classifyPurchaserOverlap({ overlapRatio: 0.14 }), "defer");
});

test("classifyPurchaserOverlap — 0.15 overlap proceeds (exactly at the goal's threshold)", () => {
  assert.equal(classifyPurchaserOverlap({ overlapRatio: 0.15 }), "proceed");
});

test("classifyPurchaserOverlap — 0.20 overlap proceeds (well above threshold)", () => {
  assert.equal(classifyPurchaserOverlap({ overlapRatio: 0.20 }), "proceed");
});

test("classifyPurchaserOverlap — null / missing overlap defers (never auto-ships on unmeasured)", () => {
  assert.equal(classifyPurchaserOverlap(null), "defer");
  assert.equal(classifyPurchaserOverlap(undefined), "defer");
  assert.equal(classifyPurchaserOverlap({ overlapRatio: null }), "defer");
});

test("classifyPurchaserOverlap — respects an explicit custom threshold", () => {
  assert.equal(classifyPurchaserOverlap({ overlapRatio: 0.25 }, 0.30), "defer");
  assert.equal(classifyPurchaserOverlap({ overlapRatio: 0.30 }, 0.30), "proceed");
});

test("PURCHASER_OVERLAP_DEFAULT_THRESHOLD is the goal's 15% number", () => {
  assert.equal(PURCHASER_OVERLAP_DEFAULT_THRESHOLD, 0.15);
});
