/**
 * Unit tests for the ready-to-test reader (growth-adopt-creative-makers spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:ready-to-test
 *   (= tsx --test src/lib/ads/ready-to-test.test.ts)
 *
 * Covers the two fixtures the spec asks for:
 *   - a ready campaign with no publish job returns `ready_no_active_ad`;
 *   - one with an in-flight publish job is excluded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { listReadyToTest } from "./ready-to-test";

// ── Fake admin client (the minimum chain `listReadyToTest` exercises) ─────────────────────────────
// `listReadyToTest` reads three tables (`ad_videos`, `ad_campaigns`, `ad_publish_jobs`) and chains
// `.select/.eq/.in/.not` on each, terminating with a plain `await`. We model the chain as a thenable
// per `.from(table)` call that ignores filter args (the reader's own filtering happens in JS after the
// await, so we just hand the chain a fixed table-shape result and let the reader's logic do its job).
interface FakeTableRow {
  data: unknown;
  error: null;
}

function makeChain(result: FakeTableRow) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.neq = () => chain;
  chain.in = () => chain;
  chain.not = () => chain;
  chain.is = () => chain;
  chain.then = (onFulfilled: (v: FakeTableRow) => unknown) => Promise.resolve(result).then(onFulfilled);
  return chain;
}

function makeAdmin(tables: Record<string, FakeTableRow>) {
  return {
    from(table: string) {
      const result = tables[table] ?? { data: [], error: null };
      return makeChain(result);
    },
  } as unknown as Parameters<typeof listReadyToTest>[0];
}

test("a ready campaign with no publish job returns `ready_no_active_ad`", async () => {
  // ad_videos: two sibling rows (reels mp4 + feed-4:5 mp4) both `status='ready'` on campaign C1.
  // ad_campaigns: C1 has a landing_url set.
  // ad_publish_jobs: empty — no in-flight launch for C1.
  const admin = makeAdmin({
    ad_videos: {
      data: [
        { campaign_id: "C1", format: "reels_9x16", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
        { campaign_id: "C1", format: "feed_4x5", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
      ],
      error: null,
    },
    ad_campaigns: {
      data: [
        { id: "C1", landing_url: "https://superfoods.com/products/x", status: "ready", created_at: "2026-06-29T10:00:00Z" },
      ],
      error: null,
    },
    ad_publish_jobs: { data: [], error: null },
  });

  const { readyToTest } = await listReadyToTest(admin, { workspaceId: "ws-1" });

  assert.equal(readyToTest.length, 1);
  assert.equal(readyToTest[0].ad_campaign_id, "C1");
  assert.equal(readyToTest[0].status, "ready_no_active_ad");
  assert.equal(readyToTest[0].lander_url, "https://superfoods.com/products/x");
  assert.equal(readyToTest[0].archetype, null);
  assert.equal(readyToTest[0].created_at, "2026-06-29T10:00:00Z");
  assert.deepEqual(readyToTest[0].formats, ["feed_4x5", "reels_9x16"]);
});

test("a campaign with an in-flight publish job is excluded", async () => {
  // C1 is ready; C2 is also ready BUT has an `ad_publish_jobs` row `publish_status='creating'`.
  // Only C1 should surface as ready_no_active_ad.
  const admin = makeAdmin({
    ad_videos: {
      data: [
        { campaign_id: "C1", format: "reels_9x16", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
        { campaign_id: "C2", format: "feed_4x5", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
      ],
      error: null,
    },
    ad_campaigns: {
      data: [
        { id: "C1", landing_url: "https://superfoods.com/products/x", status: "ready", created_at: "2026-06-29T10:00:00Z" },
        { id: "C2", landing_url: "https://superfoods.com/products/y", status: "ready", created_at: "2026-06-28T10:00:00Z" },
      ],
      error: null,
    },
    ad_publish_jobs: {
      data: [{ campaign_id: "C2", publish_status: "creating" }],
      error: null,
    },
  });

  const { readyToTest } = await listReadyToTest(admin, { workspaceId: "ws-1" });

  assert.equal(readyToTest.length, 1);
  assert.equal(readyToTest[0].ad_campaign_id, "C1");
});

test("a `media_kind='static'` row with a final JPG counts even if `status` is not `ready` — archetype propagates", async () => {
  // Belt-and-suspenders: the spec's OR clause. A static row with a JPG counts as a ready creative; the
  // archetype from its meta is the row-level archetype.
  const admin = makeAdmin({
    ad_videos: {
      data: [
        {
          campaign_id: "C3",
          format: "feed_4x5",
          media_kind: "static",
          status: "rendering",
          static_jpg_url: "https://cdn.example/static.jpg",
          meta: { archetype: "review" },
        },
      ],
      error: null,
    },
    ad_campaigns: {
      data: [{ id: "C3", landing_url: "https://superfoods.com/products/z", status: "ready", created_at: "2026-06-30T10:00:00Z" }],
      error: null,
    },
    ad_publish_jobs: { data: [], error: null },
  });

  const { readyToTest } = await listReadyToTest(admin, { workspaceId: "ws-1" });

  assert.equal(readyToTest.length, 1);
  assert.equal(readyToTest[0].ad_campaign_id, "C3");
  assert.equal(readyToTest[0].archetype, "review");
  assert.deepEqual(readyToTest[0].formats, ["feed_4x5"]);
});

test("a `failed` publish job does not block — the campaign is still pending a successful launch", async () => {
  // The reader treats `failed` as "no launch yet"; only queued|uploading|creating|published block.
  const admin = makeAdmin({
    ad_videos: {
      data: [
        { campaign_id: "C4", format: "reels_9x16", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
      ],
      error: null,
    },
    ad_campaigns: {
      data: [{ id: "C4", landing_url: "https://superfoods.com/products/w", status: "ready", created_at: "2026-06-27T10:00:00Z" }],
      error: null,
    },
    ad_publish_jobs: {
      data: [{ campaign_id: "C4", publish_status: "failed" }],
      error: null,
    },
  });

  // The fake admin returns the full publish-jobs array; the reader's `.in('publish_status', ACTIVE…)`
  // filter would normally exclude the `failed` row at the DB. To prove the reader is correct even when
  // the filter is bypassed (e.g. a server-side mismatch), the chain-mock passes the row through, and
  // the reader's JS-side blocked-set correctly omits it (only ACTIVE_PUBLISH_STATUSES enter `blocked`).
  // To explicitly verify the JS-side behavior, return the same row from the publish_jobs slot.
  const { readyToTest } = await listReadyToTest(admin, { workspaceId: "ws-1" });
  assert.equal(readyToTest.length, 1);
  assert.equal(readyToTest[0].ad_campaign_id, "C4");
});

test("an archived (URL-removed / retired) campaign is excluded even with a ready ad_video + landing_url + no active publish job", async () => {
  // The retire path in production: the operator removes a launched ad's URL, which flips
  // `ad_campaigns.status` to 'archived'. Its sibling ad_video is still `status='ready'` and the
  // landing_url can linger — so the ONLY signal that keeps the reader honest is the campaign-level
  // status filter. Without it, Dahlia sees a full bin, /director-training reports depth that
  // doesn't exist, and media-buyer replenish could republish a retired creative.
  const admin = makeAdmin({
    ad_videos: {
      data: [
        { campaign_id: "C6", format: "reels_9x16", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
      ],
      error: null,
    },
    // The prod query does `.neq('status','archived')` at the DB, but the fake chain ignores filter
    // args — so we hand the reader the archived row directly and prove the JS-side belt-and-
    // suspenders guard (`if (c.status === 'archived') continue`) still drops it.
    ad_campaigns: {
      data: [
        { id: "C6", landing_url: "https://superfoods.com/products/retired", status: "archived", created_at: "2026-06-26T10:00:00Z" },
      ],
      error: null,
    },
    ad_publish_jobs: { data: [], error: null },
  });

  const { readyToTest } = await listReadyToTest(admin, { workspaceId: "ws-1" });
  assert.equal(readyToTest.length, 0);
});

test("a campaign with no landing_url is excluded even when its videos are ready", async () => {
  // `ad_campaigns` is fetched with `.not('landing_url', 'is', null)` — so the fake returns NO row for
  // C5 to mirror what the DB query would return.
  const admin = makeAdmin({
    ad_videos: {
      data: [
        { campaign_id: "C5", format: "reels_9x16", media_kind: "video", status: "ready", static_jpg_url: null, meta: {} },
      ],
      error: null,
    },
    ad_campaigns: { data: [], error: null },
    ad_publish_jobs: { data: [], error: null },
  });

  const { readyToTest } = await listReadyToTest(admin, { workspaceId: "ws-1" });
  assert.equal(readyToTest.length, 0);
});
