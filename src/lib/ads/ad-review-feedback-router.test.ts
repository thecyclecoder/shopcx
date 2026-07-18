/**
 * ad-review-feedback-router tests — Phase 2 of ceo-manual-ad-review-inline-per-element-
 * feedback-routed-to-dahlia-max-render. Pins the CEO-approved contract in the spec:
 *
 *   "a packet with one image + one copy + one max entry produces exactly the three
 *    targeted re-drives plus the final re-QA, and untargeted elements produce no job."
 *
 * Test-first for the exact predicate (coaching guidance #14) — assert the shape of the
 * plan before the caller can enqueue anything against it.
 *
 * Built-in node:test — no runner dep. Run:
 *   npx tsx --test src/lib/ads/ad-review-feedback-router.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { routeAdReviewFeedback } from "./ad-review-feedback-router";
import type { AdReviewFeedbackPacket } from "./ad-review-feedback";

const CTX = {
  adCampaignId: "cmp_00000000-0000-0000-0000-000000000001",
  adReviewFeedbackId: "fb_00000000-0000-0000-0000-000000000002",
};

test("mixed packet (1 image + 1 copy + 1 max) → 3 targeted re-drives + 1 final re-QA", () => {
  const packet: AdReviewFeedbackPacket = {
    entries: [
      { targetKind: "render-format", format: "feed_4x5", comment: "product box is off" },
      { targetKind: "copy-variation", framework: "lf8", comment: "hook is too soft" },
      { targetKind: "max-grade", comment: "you scored this too low" },
    ],
  };
  const specs = routeAdReviewFeedback(packet, CTX);
  assert.equal(specs.length, 4, "3 targeted + 1 final re-QA");

  // Targeted specs come first, in packet order.
  assert.equal(specs[0].kind, "ad-creative");
  assert.equal(specs[0].instructions.format, "feed_4x5");
  assert.equal(specs[0].instructions.ad_campaign_id, CTX.adCampaignId);
  assert.equal(specs[0].instructions.revise_reason, "product box is off");

  assert.equal(specs[1].kind, "ad-creative-copy-author");
  assert.equal(specs[1].instructions.framework, "lf8");
  assert.equal(specs[1].instructions.revise_reason, "hook is too soft");

  assert.equal(specs[2].kind, "ad-creative-copy-qc");
  assert.equal(specs[2].instructions.mode, "correction");
  assert.equal(specs[2].instructions.revise_reason, "you scored this too low");

  // Trailing whole-ad Max re-QA — no source entry, mode='final-re-qa'.
  assert.equal(specs[3].kind, "ad-creative-copy-qc");
  assert.equal(specs[3].instructions.mode, "final-re-qa");
  assert.equal(specs[3].entry, null);
});

test("canonical-copy entry routes to ad-creative-copy-author without a framework key", () => {
  const packet: AdReviewFeedbackPacket = {
    entries: [{ targetKind: "canonical-copy", comment: "punch harder" }],
  };
  const specs = routeAdReviewFeedback(packet, CTX);
  assert.equal(specs.length, 2, "1 targeted + 1 final re-QA");
  assert.equal(specs[0].kind, "ad-creative-copy-author");
  assert.equal(specs[0].instructions.targetKind, "canonical-copy");
  assert.equal((specs[0].instructions as { framework?: unknown }).framework, undefined);
});

test("only untargeted elements (an empty entries list is rejected upstream by the parser); a single-entry packet produces exactly 2 specs", () => {
  // Empty-entries packets are dropped by parseAdReviewFeedbackPacket at build time; the router
  // is never asked to enumerate untargeted elements. This test pins the smaller invariant:
  // ONE targeted entry always produces ONE targeted spec + ONE final re-QA — never any "phantom"
  // spec for an untargeted element (a copy slot the CEO left blank).
  const packet: AdReviewFeedbackPacket = {
    entries: [{ targetKind: "render-format", format: "stories_9x16", comment: "resize the pack" }],
  };
  const specs = routeAdReviewFeedback(packet, CTX);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].kind, "ad-creative");
  assert.equal(specs[0].instructions.format, "stories_9x16");
  assert.equal(specs[1].instructions.mode, "final-re-qa");
});

test("every re-drive carries ad_review_feedback_id + ad_campaign_id — the join keys the receiving lane reads", () => {
  const packet: AdReviewFeedbackPacket = {
    entries: [
      { targetKind: "render-format", format: "reels_9x16", comment: "x" },
      { targetKind: "copy-variation", framework: "sugarman", comment: "y" },
    ],
  };
  const specs = routeAdReviewFeedback(packet, CTX);
  for (const spec of specs) {
    assert.equal(spec.instructions.ad_review_feedback_id, CTX.adReviewFeedbackId);
    assert.equal(spec.instructions.ad_campaign_id, CTX.adCampaignId);
  }
});
