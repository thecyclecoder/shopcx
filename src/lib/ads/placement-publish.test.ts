/**
 * Unit tests for `resolvePlacementPublish` — bianca-publishes-3-placement-multi-copy-
 * via-placement-customization Phase 2 verification. The predicate is the routing
 * decision Bianca's publish path uses to pick the 3-bucket PLACEMENT builder over
 * the legacy 2-bucket / single-image path.
 *
 * Verification bullets ⇒ tests:
 *   1. "a publish job for a complete pack resolves 3 placement hashes and calls
 *      the 3-bucket builder with 4 headlines + 4 primary texts" ⇒
 *      `ready:true` names feed/story/rightColumn AdVideo rows, so the ad-tool
 *      publisher will upload all 3 and call `createPlacementCreative`.
 *   2. "the single-image path is untouched for creatives without a full pack" ⇒
 *      every missing piece (video kind, missing feed, missing 9:16, missing
 *      right-column, <4 headlines, <4 primary texts) returns `ready:false` with
 *      a stable reason, so the publisher falls through to legacy paths.
 *
 * Run:  npx tsx --test src/lib/ads/placement-publish.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlacementPublish, type PlacementPublishAdVideo } from "./placement-publish";

const HEADLINES_4 = ["h1", "h2", "h3", "h4"];
const PRIMARY_4 = ["p1", "p2", "p3", "p4"];

function pack(overrides: Partial<PlacementPublishAdVideo> = {}): PlacementPublishAdVideo[] {
  return [
    { id: "vid-feed", format: "feed_4x5", media_kind: "static", static_jpg_url: "https://s/feed.jpg", ...overrides },
    { id: "vid-story", format: "stories_9x16", media_kind: "static", static_jpg_url: "https://s/story.jpg" },
    { id: "vid-right", format: "right_column_1x1", media_kind: "static", static_jpg_url: "https://s/right.jpg" },
  ];
}

test("resolvePlacementPublish — complete pack ⇒ ready with feed/story/rightColumn", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack(),
  });
  assert.equal(decision.ready, true);
  if (!decision.ready) throw new Error("unreachable");
  assert.equal(decision.feed.format, "feed_4x5");
  assert.equal(decision.story.format, "stories_9x16");
  assert.equal(decision.rightColumn.format, "right_column_1x1");
  // The routing consumer (ad-tool.ts publish step) resolves URLs from these rows
  // and passes 3 hashes + 4 headlines + 4 primary texts to createPlacementCreative.
  assert.ok(decision.feed.static_jpg_url && decision.story.static_jpg_url && decision.rightColumn.static_jpg_url);
});

test("resolvePlacementPublish — reels_9x16 satisfies the 9:16 slot", () => {
  const rows = pack().map((r) => (r.format === "stories_9x16" ? { ...r, format: "reels_9x16" } : r));
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: rows,
  });
  assert.equal(decision.ready, true);
  if (!decision.ready) throw new Error("unreachable");
  assert.equal(decision.story.format, "reels_9x16");
});

test("resolvePlacementPublish — video mediaKind falls through to legacy path", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "video",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack(),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "not_static");
});

test("resolvePlacementPublish — missing feed_4x5 ⇒ fallback + stable reason", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack().filter((r) => r.format !== "feed_4x5"),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "missing_feed_4x5");
});

test("resolvePlacementPublish — missing 9:16 ⇒ fallback + stable reason", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack().filter((r) => r.format !== "stories_9x16"),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "missing_9x16_sibling");
});

test("resolvePlacementPublish — missing right_column_1x1 ⇒ fallback + stable reason", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack().filter((r) => r.format !== "right_column_1x1"),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "missing_right_column_1x1");
});

test("resolvePlacementPublish — <4 headlines ⇒ fallback (single-image path untouched)", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: ["h1", "h2", "h3"],
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack(),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "headlines_below_min");
});

test("resolvePlacementPublish — <4 primary texts ⇒ fallback (single-image path untouched)", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: ["p1", "p2", "p3"],
    readyAdVideos: pack(),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "primary_texts_below_min");
});

test("resolvePlacementPublish — non-static ad_videos rows are ignored", () => {
  const rows: PlacementPublishAdVideo[] = [
    ...pack(),
    { id: "vid-vid", format: "feed_4x5", media_kind: "video" },
  ];
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: HEADLINES_4,
    primaryTexts: PRIMARY_4,
    readyAdVideos: rows,
  });
  assert.equal(decision.ready, true);
  if (!decision.ready) throw new Error("unreachable");
  // Feed was picked from the static rows, not the mismatched-kind row.
  assert.equal(decision.feed.id, "vid-feed");
  assert.equal(decision.feed.media_kind, "static");
});

test("resolvePlacementPublish — empty headline strings do not count toward the 4-minimum", () => {
  const decision = resolvePlacementPublish({
    mediaKind: "static",
    headlines: ["h1", "", "  ", "h4"],
    primaryTexts: PRIMARY_4,
    readyAdVideos: pack(),
  });
  assert.equal(decision.ready, false);
  if (decision.ready) throw new Error("unreachable");
  assert.equal(decision.reason, "headlines_below_min");
});
