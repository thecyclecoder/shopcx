/**
 * Unit tests for the angle-before-ready guard helper
 * (dahlia-creative-requires-angle-before-ready spec, Phase 1).
 *
 * Built-in node:test — no runner dep. Run:
 *   npx tsx --test src/lib/ads/creative-agent.test.ts
 *
 * Covers the spec's failing state directly:
 *   - A null angle_id must NEVER map to status='ready' (the media-buyer replenish path skips
 *     angle-less campaigns, so a ready+null row inflates bin depth with un-replenishable creatives).
 *   - A resolved angle_id keeps the ready state — the guard doesn't leak past the null branch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readyStatusForAngle } from "./creative-agent";

test("readyStatusForAngle holds a null angle out of 'ready'", () => {
  assert.equal(readyStatusForAngle(null), "draft");
  assert.equal(readyStatusForAngle(undefined), "draft");
  assert.equal(readyStatusForAngle(""), "draft");
});

test("readyStatusForAngle lets a resolved angle land at 'ready'", () => {
  assert.equal(readyStatusForAngle("angle-uuid"), "ready");
});
