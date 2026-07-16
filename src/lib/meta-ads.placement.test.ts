/**
 * Unit tests for `createPlacementCreative` —
 * bianca-publishes-3-placement-multi-copy-via-placement-customization Phase 1
 * verification. Stubs `globalThis.fetch` so `graphFetchJson` never hits Meta and
 * asserts the exact battle-tested payload (creative 780957111743379):
 *   - `optimization_type:'PLACEMENT'` and `ad_formats:['AUTOMATIC_FORMAT']`
 *     (never a Dynamic Creative marker: `is_dynamic_creative` / `SINGLE_*`)
 *   - 3 image hashes with correct adlabels (feed image doubles as `default`)
 *   - 4 titles + 4 bodies each labeled to ALL four placements
 *   - 4 asset_customization_rules including the `right_hand_column` rule
 *   - `text_optimizations = OPT_OUT`
 *
 * Run:  npx tsx --test src/lib/meta-ads.placement.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPlacementCreative } from "./meta-ads";

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
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const HEADLINES = ["h1", "h2", "h3", "h4"];
const PRIMARY_TEXTS = ["p1", "p2", "p3", "p4"];

async function callBuilder(): Promise<Call> {
  const stub = stubFetch(() => ({ json: { id: "780000000000000" } }));
  try {
    const id = await createPlacementCreative("tok", {
      accountId: "act_9999",
      name: "cx placement test",
      pageId: "111",
      instagramUserId: "222",
      headlines: HEADLINES,
      primaryTexts: PRIMARY_TEXTS,
      description: "desc",
      ctaType: "SHOP_NOW",
      destinationUrl: "https://example.com/lp",
      displayUrl: "example.com",
      urlTags: "utm_source=meta&utm_medium=paid_social",
      feedImageHash: "hash_feed",
      storyImageHash: "hash_story",
      rightColumnImageHash: "hash_rightcol",
    });
    assert.equal(id, "780000000000000");
    assert.equal(stub.calls.length, 1);
    return stub.calls[0]!;
  } finally {
    stub.restore();
  }
}

test("createPlacementCreative — PLACEMENT + AUTOMATIC_FORMAT, no DCO markers", async () => {
  const call = await callBuilder();
  assert.equal(call.method, "POST");
  assert.ok(call.url.includes("/act_9999/adcreatives"), `adcreatives endpoint, got ${call.url}`);

  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  assert.equal(afs.optimization_type, "PLACEMENT");
  assert.deepEqual(afs.ad_formats, ["AUTOMATIC_FORMAT"], "must NOT pin SINGLE_IMAGE (that flips to Dynamic Creative)");

  // Portable — NOT Dynamic Creative. `is_dynamic_creative` or a pinned SINGLE_*
  // format is what makes the creative unusable outside a DCO adset. The battle-
  // tested payload has neither.
  assert.equal(call.body.get("is_dynamic_creative"), null, "must not carry is_dynamic_creative");
  const formats: string[] = afs.ad_formats;
  for (const f of formats) {
    assert.ok(!/^SINGLE_/i.test(f), `ad_formats must not include a SINGLE_* (DCO) format, saw ${f}`);
  }
});

test("createPlacementCreative — 3 images with correct adlabels; feed image doubles as default", async () => {
  const call = await callBuilder();
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const images: Array<{ hash: string; adlabels: Array<{ name: string }> }> = afs.images;
  assert.equal(images.length, 3, "exactly 3 image hashes (feed/stories/rightcol)");

  const feedImg = images.find((im) => im.hash === "hash_feed");
  const storyImg = images.find((im) => im.hash === "hash_story");
  const rightImg = images.find((im) => im.hash === "hash_rightcol");
  assert.ok(feedImg && storyImg && rightImg, "all three hashes present");

  const labelNames = (im: { adlabels: Array<{ name: string }> }) => im.adlabels.map((l) => l.name);
  const feedLabels = labelNames(feedImg!);
  assert.ok(feedLabels.some((n) => n.endsWith("_img_feed")), "feed image has _img_feed adlabel");
  assert.ok(feedLabels.some((n) => n.endsWith("_img_default")), "feed image ALSO carries the _img_default adlabel");
  assert.deepEqual(labelNames(storyImg!).filter((n) => n.endsWith("_img_stories")).length, 1);
  assert.deepEqual(labelNames(rightImg!).filter((n) => n.endsWith("_img_rightcol")).length, 1);
});

test("createPlacementCreative — 4 titles + 4 bodies, each labeled to ALL placements", async () => {
  const call = await callBuilder();
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");

  const titles: Array<{ text: string; adlabels: Array<{ name: string }> }> = afs.titles;
  const bodies: Array<{ text: string; adlabels: Array<{ name: string }> }> = afs.bodies;
  assert.equal(titles.length, 4, "4 headlines");
  assert.equal(bodies.length, 4, "4 primary texts");
  assert.deepEqual(titles.map((t) => t.text), HEADLINES);
  assert.deepEqual(bodies.map((b) => b.text), PRIMARY_TEXTS);

  // Every title/body carries the same 4 adlabels — one per placement.
  const expectTitleSuffixes = ["_title_feed", "_title_stories", "_title_rightcol", "_title_default"].sort();
  const expectBodySuffixes = ["_body_feed", "_body_stories", "_body_rightcol", "_body_default"].sort();
  for (const t of titles) {
    const suffixes = t.adlabels.map((l) => l.name.replace(/^cx_\d+/, "")).sort();
    assert.deepEqual(suffixes, expectTitleSuffixes, `title "${t.text}" must adlabel every placement`);
  }
  for (const b of bodies) {
    const suffixes = b.adlabels.map((l) => l.name.replace(/^cx_\d+/, "")).sort();
    assert.deepEqual(suffixes, expectBodySuffixes, `body "${b.text}" must adlabel every placement`);
  }

  const links: Array<{ website_url: string; display_url?: string; adlabels: Array<{ name: string }> }> = afs.link_urls;
  assert.equal(links.length, 1);
  assert.equal(links[0]!.website_url, "https://example.com/lp");
  assert.equal(links[0]!.display_url, "example.com");
  assert.equal(links[0]!.adlabels.length, 4, "single link URL adlabel'd to all placements");
});

test("createPlacementCreative — 4 asset_customization_rules incl. a right_hand_column rule", async () => {
  const call = await callBuilder();
  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  const rules: Array<{
    customization_spec: { facebook_positions?: string[]; instagram_positions?: string[]; publisher_platforms?: string[] };
    image_label: { name: string };
    priority: number;
  }> = afs.asset_customization_rules;

  assert.equal(rules.length, 4, "4 rules — feed / stories / rightcol / default");
  const priorities = rules.map((r) => r.priority).sort((x, y) => x - y);
  assert.deepEqual(priorities, [1, 2, 3, 4]);

  const rightcolRule = rules.find((r) => r.customization_spec.facebook_positions?.includes("right_hand_column"));
  assert.ok(rightcolRule, "must include a right_hand_column customization rule");
  assert.ok(rightcolRule!.customization_spec.facebook_positions!.includes("search"), "right-column rule also targets FB search");
  assert.ok(rightcolRule!.image_label.name.endsWith("_img_rightcol"), "right-column rule points at the rightcol image label");

  const defaultRule = rules.find((r) => r.priority === 4);
  assert.ok(defaultRule, "must include a default (priority 4) rule");
  const dspec = defaultRule!.customization_spec as Record<string, unknown>;
  assert.equal(dspec.publisher_platforms, undefined, "default rule spec is empty (no platform pin)");
  assert.equal(dspec.facebook_positions, undefined);
  assert.equal(dspec.instagram_positions, undefined);
});

test("createPlacementCreative — text_optimizations OPT_OUT, single CTA, url_tags preserved", async () => {
  const call = await callBuilder();

  const dof = JSON.parse(call.body.get("degrees_of_freedom_spec") || "{}");
  assert.equal(dof.creative_features_spec.text_optimizations.enroll_status, "OPT_OUT",
    "Meta must NOT rewrite our copy");

  const afs = JSON.parse(call.body.get("asset_feed_spec") || "{}");
  assert.deepEqual(afs.call_to_action_types, ["SHOP_NOW"]);

  assert.equal(call.body.get("url_tags"), "utm_source=meta&utm_medium=paid_social");

  const oss = JSON.parse(call.body.get("object_story_spec") || "{}");
  assert.equal(oss.page_id, "111");
  assert.equal(oss.instagram_user_id, "222");
  assert.equal(oss.link_data, undefined, "no link_data on the story spec (fights asset_customization_rules)");
  assert.equal(oss.image_data, undefined, "no image_data on the story spec (fights asset_customization_rules)");
});
