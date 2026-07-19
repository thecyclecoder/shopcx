/**
 * bianca-static-publish-uses-all-5-copy-variations-and-correct-right-column-placement Phase 2
 * verification — `createDualAssetCreative` unit tests over the right-column 1:1 mapping.
 *
 * Two scenarios pinned side-by-side so a stray refactor that drops either shape reds one test:
 *   1. `rightColumnImageHash` PRESENT (Phase 2 opt-in) — the built creative carries 3 images
 *      (feed 4:5 + stories 9:16 + right_column 1:1), 4 asset_customization_rules incl. a
 *      `right_hand_column` (+ `search`) rule bound to the 1:1 image_label, and feed 4:5 is
 *      the priority-4 default fallback via its shared `default` adlabel.
 *   2. `rightColumnImageHash` ABSENT (legacy 2-bucket) — the built creative preserves the
 *      pre-Phase-2 shape byte-identically: 2 images (feed + stories), 3 rules
 *      (feed / stories / default), story 9:16 doubles as the default fallback via its shared
 *      `default` adlabel, feed rule still includes `search`.
 *
 * Run:  npx tsx --test src/lib/meta-ads.dual.rightcol.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDualAssetCreative } from "./meta-ads";

interface Call { url: string; method: string; body: URLSearchParams }

function stubFetch(handler: (call: Call) => { status?: number; json: Record<string, unknown> }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const call = { url, method, body };
    calls.push(call);
    const { status, json } = handler(call);
    return new Response(JSON.stringify(json), {
      status: status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore() { globalThis.fetch = original; } };
}

async function callDual(overrides: Partial<Parameters<typeof createDualAssetCreative>[1]>): Promise<Call> {
  const stub = stubFetch(() => ({ json: { id: "780000000000042" } }));
  try {
    const id = await createDualAssetCreative("tok", {
      accountId: "act_1234",
      name: "cx dual right-col test",
      pageId: "111",
      instagramUserId: "222",
      headlines: ["h1", "h2"],
      primaryTexts: ["p1", "p2"],
      description: "desc",
      ctaType: "SHOP_NOW",
      destinationUrl: "https://example.com/lp",
      urlTags: "utm_source=meta&utm_medium=paid_social",
      feedImageHash: "hash_feed",
      storyImageHash: "hash_story",
      ...overrides,
    });
    assert.equal(id, "780000000000042");
    assert.equal(stub.calls.length, 1);
    return stub.calls[0]!;
  } finally {
    stub.restore();
  }
}

// ── Phase 2: rightColumnImageHash PRESENT ────────────────────────────────────

test("Phase 2 — dual+rightColumnImageHash: 3 images incl. hash_rightcol; feed image ALSO carries the _img_default adlabel (feed 4:5 is the safe default fallback)", async () => {
  const call = await callDual({ rightColumnImageHash: "hash_rightcol" });
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const images: Array<{ hash: string; adlabels: Array<{ name: string }> }> = afs.images;
  assert.equal(images.length, 3, "3 image hashes (feed/stories/rightcol) — right-column 1:1 mapped");

  const feedImg = images.find((im) => im.hash === "hash_feed");
  const storyImg = images.find((im) => im.hash === "hash_story");
  const rightImg = images.find((im) => im.hash === "hash_rightcol");
  assert.ok(feedImg && storyImg && rightImg, "all three hashes present");

  const labelNames = (im: { adlabels: Array<{ name: string }> }) => im.adlabels.map((l) => l.name);
  const feedLabels = labelNames(feedImg!);
  assert.ok(feedLabels.some((n) => n.endsWith("_img_feed")), "feed image carries _img_feed");
  assert.ok(feedLabels.some((n) => n.endsWith("_img_default")), "feed image ALSO carries _img_default (Phase 2 safe fallback)");
  assert.deepEqual(labelNames(storyImg!).filter((n) => n.endsWith("_img_stories")).length, 1, "story image carries _img_stories");
  assert.ok(!labelNames(storyImg!).some((n) => n.endsWith("_img_default")), "story image NO LONGER carries _img_default (moved to feed 4:5)");
  assert.deepEqual(labelNames(rightImg!).filter((n) => n.endsWith("_img_rightcol")).length, 1, "right-column image carries _img_rightcol");
});

test("Phase 2 — dual+rightColumnImageHash: 4 asset_customization_rules with a right_hand_column rule bound to the 1:1 image_label", async () => {
  const call = await callDual({ rightColumnImageHash: "hash_rightcol" });
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const rules: Array<{
    customization_spec: { facebook_positions?: string[]; instagram_positions?: string[]; publisher_platforms?: string[] };
    image_label?: { name: string };
    priority: number;
  }> = afs.asset_customization_rules;

  assert.equal(rules.length, 4, "4 rules — feed / stories / rightcol / default (Phase 2 3-bucket + default)");
  const priorities = rules.map((r) => r.priority).sort((x, y) => x - y);
  assert.deepEqual(priorities, [1, 2, 3, 4]);

  const rightcolRule = rules.find((r) => r.customization_spec.facebook_positions?.includes("right_hand_column"));
  assert.ok(rightcolRule, "must include a right_hand_column customization rule");
  assert.ok(rightcolRule!.customization_spec.facebook_positions!.includes("search"), "right-column rule also targets FB search");
  assert.ok(rightcolRule!.image_label?.name.endsWith("_img_rightcol"), "right-column rule points at the rightcol image label");
  assert.deepEqual(rightcolRule!.customization_spec.publisher_platforms, ["facebook"], "right-column rule is FB-only");

  const defaultRule = rules.find((r) => r.priority === 4);
  assert.ok(defaultRule, "must include a default (priority 4) rule");
  const dspec = defaultRule!.customization_spec as Record<string, unknown>;
  assert.equal(dspec.publisher_platforms, undefined, "default rule spec is empty (no platform pin)");
  assert.equal(dspec.facebook_positions, undefined);
  assert.equal(dspec.instagram_positions, undefined);
  assert.ok(defaultRule!.image_label?.name.endsWith("_img_default"), "default rule points at the _img_default label (feed 4:5 carries it via shared adlabel)");
});

test("Phase 2 — dual+rightColumnImageHash: feed rule no longer includes 'search' (rightcol rule owns it)", async () => {
  const call = await callDual({ rightColumnImageHash: "hash_rightcol" });
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const rules: Array<{
    customization_spec: { facebook_positions?: string[] };
    image_label?: { name: string };
    priority: number;
  }> = afs.asset_customization_rules;
  const feedRule = rules.find((r) => r.image_label?.name.endsWith("_img_feed"));
  assert.ok(feedRule, "feed rule present");
  assert.ok(feedRule!.customization_spec.facebook_positions!.includes("feed"), "feed rule targets FB feed");
  assert.ok(!feedRule!.customization_spec.facebook_positions!.includes("search"), "feed rule no longer includes 'search' (right-column rule now owns it)");
});

test("Phase 2 — dual+rightColumnImageHash: titles + bodies each carry the 4 placement adlabels (rightcol included)", async () => {
  const call = await callDual({ rightColumnImageHash: "hash_rightcol" });
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const titles: Array<{ text: string; adlabels: Array<{ name: string }> }> = afs.titles;
  const bodies: Array<{ text: string; adlabels: Array<{ name: string }> }> = afs.bodies;
  assert.equal(titles.length, 2);
  assert.equal(bodies.length, 2);

  const stripPrefix = (l: { name: string }) => l.name.replace(/^cx_\d+/, "");
  const titleSuffixes = titles[0]!.adlabels.map(stripPrefix).sort();
  const bodySuffixes = bodies[0]!.adlabels.map(stripPrefix).sort();
  assert.deepEqual(titleSuffixes, ["_title_default", "_title_feed", "_title_rightcol", "_title_stories"]);
  assert.deepEqual(bodySuffixes, ["_body_default", "_body_feed", "_body_rightcol", "_body_stories"]);
});

// ── Legacy 2-bucket compat: rightColumnImageHash ABSENT ──────────────────────

test("Legacy compat — dual without rightColumnImageHash: 2 images (feed + stories), story doubles as default (byte-identical to pre-Phase-2)", async () => {
  const call = await callDual({});
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const images: Array<{ hash: string; adlabels: Array<{ name: string }> }> = afs.images;
  assert.equal(images.length, 2, "2 image hashes (no right-column) — legacy 2-bucket shape preserved");

  const feedImg = images.find((im) => im.hash === "hash_feed");
  const storyImg = images.find((im) => im.hash === "hash_story");
  assert.ok(feedImg && storyImg);
  const labelNames = (im: { adlabels: Array<{ name: string }> }) => im.adlabels.map((l) => l.name);
  assert.ok(labelNames(storyImg!).some((n) => n.endsWith("_img_default")), "legacy story image still carries _img_default");
  assert.ok(!labelNames(feedImg!).some((n) => n.endsWith("_img_default")), "legacy feed image does NOT carry _img_default");
});

test("Legacy compat — dual without rightColumnImageHash: 3 rules (feed/stories/default), no right_hand_column rule, feed rule includes 'search'", async () => {
  const call = await callDual({});
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const rules: Array<{
    customization_spec: { facebook_positions?: string[] };
    image_label?: { name: string };
    priority: number;
  }> = afs.asset_customization_rules;
  assert.equal(rules.length, 3, "3 rules — feed / stories / default (pre-Phase-2)");
  const rightcolRule = rules.find((r) => r.customization_spec.facebook_positions?.includes("right_hand_column"));
  assert.equal(rightcolRule, undefined, "no right_hand_column rule when caller opts out");
  const feedRule = rules.find((r) => r.image_label?.name.endsWith("_img_feed"));
  assert.ok(feedRule!.customization_spec.facebook_positions!.includes("search"), "legacy feed rule still includes 'search'");
});

// ── Video branch — right-column hash is IGNORED (image-only creative shape) ──

test("Video branch — dual video creative NEVER emits a right-column rule even if rightColumnImageHash is somehow passed (2-bucket video shape preserved)", async () => {
  const call = await callDual({
    feedVideoId: "vid_feed",
    storyVideoId: "vid_story",
    feedImageHash: undefined,
    storyImageHash: undefined,
    rightColumnImageHash: "hash_rightcol_ignored",
  });
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const rules: Array<{
    customization_spec: { facebook_positions?: string[] };
    image_label?: { name: string };
    priority: number;
  }> = afs.asset_customization_rules;
  assert.equal(rules.length, 3, "video branch stays 3-rule (feed/stories/default) — right-column is image-only");
  const rightcolRule = rules.find((r) => r.customization_spec.facebook_positions?.includes("right_hand_column"));
  assert.equal(rightcolRule, undefined, "video creative never carries a right_hand_column rule");
  assert.ok(!Array.isArray(afs.images), "video branch has no images[] key (videos[] only)");
  assert.ok(Array.isArray(afs.videos), "video branch has videos[] key");
});
