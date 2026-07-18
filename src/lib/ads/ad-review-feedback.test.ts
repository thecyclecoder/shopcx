/**
 * ad-review-feedback tests — Phase 1 of ceo-manual-ad-review-inline-per-element-feedback-
 * routed-to-dahlia-max-render. Covers the parser gate that the API + SDK depend on so a
 * malformed packet never reaches Postgres (and by extension, Phase 2's dispatcher never
 * has to switch on an unknown targetKind).
 *
 * Built-in node:test — no runner dep. Run:
 *   npx tsx --test src/lib/ads/ad-review-feedback.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAdReviewFeedbackPacket,
  AD_REVIEW_COMMENT_MAX_LEN,
} from "./ad-review-feedback";

test("parseAdReviewFeedbackPacket accepts a mixed packet with one entry per target-kind", () => {
  const packet = parseAdReviewFeedbackPacket({
    entries: [
      { targetKind: "render-format", format: "feed_4x5", comment: "badge is off" },
      { targetKind: "copy-variation", framework: "lf8", comment: "too soft" },
      { targetKind: "canonical-copy", comment: "punch harder" },
      { targetKind: "max-grade", comment: "you scored this too low" },
    ],
  });
  assert.equal(packet.entries.length, 4);
  assert.deepEqual(packet.entries[0], {
    targetKind: "render-format",
    format: "feed_4x5",
    comment: "badge is off",
  });
});

test("parseAdReviewFeedbackPacket rejects an empty entries array", () => {
  assert.throws(() => parseAdReviewFeedbackPacket({ entries: [] }), /non-empty/);
});

test("parseAdReviewFeedbackPacket rejects a non-object packet", () => {
  assert.throws(() => parseAdReviewFeedbackPacket(null), /object/);
  assert.throws(() => parseAdReviewFeedbackPacket("nope"), /object/);
});

test("parseAdReviewFeedbackPacket rejects an unknown targetKind", () => {
  assert.throws(
    () =>
      parseAdReviewFeedbackPacket({
        entries: [{ targetKind: "audio-track", comment: "nope" }],
      }),
    /targetKind/,
  );
});

test("parseAdReviewFeedbackPacket rejects an unknown render format", () => {
  assert.throws(
    () =>
      parseAdReviewFeedbackPacket({
        entries: [{ targetKind: "render-format", format: "banner_800x100", comment: "x" }],
      }),
    /format/,
  );
});

test("parseAdReviewFeedbackPacket rejects an unknown copy framework", () => {
  assert.throws(
    () =>
      parseAdReviewFeedbackPacket({
        entries: [{ targetKind: "copy-variation", framework: "kabbalah", comment: "x" }],
      }),
    /framework/,
  );
});

test("parseAdReviewFeedbackPacket rejects an empty comment string", () => {
  assert.throws(
    () =>
      parseAdReviewFeedbackPacket({
        entries: [{ targetKind: "canonical-copy", comment: "   " }],
      }),
    /comment/,
  );
});

test("parseAdReviewFeedbackPacket rejects a comment past the cap", () => {
  const long = "a".repeat(AD_REVIEW_COMMENT_MAX_LEN + 1);
  assert.throws(
    () =>
      parseAdReviewFeedbackPacket({
        entries: [{ targetKind: "max-grade", comment: long }],
      }),
    /exceeds/,
  );
});
