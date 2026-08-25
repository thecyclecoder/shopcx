/**
 * Unit tests for the Meta Ad Library source.
 *
 * Covers the three behaviours that, if they regress, corrupt the skeleton library silently rather
 * than loudly:
 *   1. TRANSIENT vs PERMANENT failure classification — a transient fault must be RETHROWN so the ad
 *      stays eligible next sweep; a permanent one must be RECORDED so we stop retrying forever.
 *   2. MEME counts as a static. Erth runs zero plain IMAGE ads, so an IMAGE-only filter reports a
 *      prolific advertiser as having no statics at all.
 *   3. Ads Meta took down carry no creative and must be detected before a render is attempted.
 *
 * Registered as `test:meta-ad-library` (a test no runner executes is not a test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MetaAdLibraryError,
  isRetryableGraphError,
  isCreativeRemoved,
  classifyMetaMedia,
  daysRunning,
  normalizeMetaAd,
  STATIC_MEDIA_TYPES,
} from "./meta-ad-library";
import { CreativeRenderError, isTransientRenderError, isWinner, winnerScore } from "./competitor-ad-types";

// ── 1. failure classification ──────────────────────────────────────────────────────────

test("graph rate-limit and 5xx are retryable; auth/permission are terminal", () => {
  // 4 = app rate limit, 17 = user rate limit, 2 = transient platform fault.
  for (const code of [1, 2, 4, 17, 341, 613]) {
    assert.equal(isRetryableGraphError(new MetaAdLibraryError("x", code, null, 400)), true, `code ${code}`);
  }
  assert.equal(isRetryableGraphError(new MetaAdLibraryError("x", null, null, 429)), true);
  assert.equal(isRetryableGraphError(new MetaAdLibraryError("x", null, null, 503)), true);

  // 190 = expired token, 10 = permission denied. Retrying these just burns the sweep — they are the
  // exact errors an app/page token produces against /ads_archive, and no retry ever fixes them.
  assert.equal(isRetryableGraphError(new MetaAdLibraryError("x", 190, 460, 400)), false);
  assert.equal(isRetryableGraphError(new MetaAdLibraryError("x", 10, 2332004, 400)), false);
  assert.equal(isRetryableGraphError(new Error("unrelated")), false);
});

test("a stripped creative is permanent, a flaky render is transient", () => {
  // Meta removed the ad → the snapshot renders copy + an avatar forever. Never retry.
  assert.equal(isTransientRenderError(new CreativeRenderError("no creative", true)), false);
  // A timeout / navigation blip → the ad may well render next sweep. Retry.
  assert.equal(isTransientRenderError(new CreativeRenderError("nav timeout", false)), true);
  assert.equal(isTransientRenderError(new Error("unrelated")), false);
});

// ── 2. MEME is a static ────────────────────────────────────────────────────────────────

test("MEME and IMAGE both classify as static; only VIDEO is video", () => {
  assert.equal(classifyMetaMedia("MEME"), "static");
  assert.equal(classifyMetaMedia("IMAGE"), "static");
  assert.equal(classifyMetaMedia("VIDEO"), "video");
  // A null media_type means we pulled without the filter — treat as static, the researched lane.
  assert.equal(classifyMetaMedia(null), "static");
  assert.deepEqual([...STATIC_MEDIA_TYPES], ["IMAGE", "MEME"]);
});

// ── 3. removed-creative detection ──────────────────────────────────────────────────────

test("detects both wordings Meta uses for a taken-down ad", () => {
  assert.equal(
    isCreativeRemoved({
      ad_creative_link_captions: [
        "This ad was run by an account or Page we later disabled for not following our Advertising Standards.",
      ],
    }),
    true,
  );
  assert.equal(
    isCreativeRemoved({
      ad_creative_link_captions: ["This content was removed because it didn't follow our Advertising Standards."],
    }),
    true,
  );
  assert.equal(isCreativeRemoved({ ad_creative_link_captions: ["learn.erthlabs.co"] }), false);
  assert.equal(isCreativeRemoved({}), false);
});

// ── longevity ──────────────────────────────────────────────────────────────────────────

test("daysRunning measures to now while an ad is still live", () => {
  // Meta returns DATE-ONLY strings, which parse as UTC midnight — so an ad started 10 days ago has
  // been live for 10 days plus the current time-of-day, and the round lands on 10 or 11 depending
  // on when the test runs. Assert the range rather than baking in a flake.
  const start = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
  const live = daysRunning({ ad_delivery_start_time: start });
  assert.ok(live === 10 || live === 11, `expected 10 or 11, got ${live}`);

  // A stopped ad measures start→stop, not start→now — fully deterministic.
  assert.equal(
    daysRunning({ ad_delivery_start_time: "2026-01-01", ad_delivery_stop_time: "2026-01-31" }),
    30,
  );
  assert.equal(daysRunning({}), 0);
});

test("winner gate is longevity-only and prefers a still-running ad", () => {
  assert.equal(isWinner({ days_count: 7 }), true);
  assert.equal(isWinner({ days_count: 6 }), false);
  assert.equal(isWinner({ days_count: 6 }, { minDays: 5 }), true);
  // Same age, but one is still being paid for — that one ranks higher.
  const live = winnerScore({ days_count: 30, resume_advertising_flag: true });
  const dead = winnerScore({ days_count: 30, resume_advertising_flag: false });
  assert.ok(live > dead);
});

// ── normalization ──────────────────────────────────────────────────────────────────────

test("normalize maps a live Erth-shaped row and nulls what Meta cannot supply", () => {
  const row = {
    id: "984922267830683",
    page_id: "656545627533387",
    page_name: "Erth Labs",
    ad_creative_bodies: ["Superfood Brew blends rich, premium coffee…"],
    ad_creative_link_titles: ["40% OFF + FREE Gifts Ends Soon! 🎁"],
    ad_creative_link_captions: ["https://learn.erthlabs.co/reasons2"],
    ad_delivery_start_time: "2026-05-22",
    ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=984922267830683&access_token=x",
    publisher_platforms: ["facebook", "instagram"],
  };
  const ad = normalizeMetaAd(row, "MEME");

  assert.equal(ad.ad_key, "984922267830683");
  assert.equal(ad.advertiser, "Erth Labs");
  assert.equal(ad.media_type, "static");
  // A full url caption is the advertorial — keep the PATH, since the bare root often 404s.
  assert.equal(ad.landing_page_url, "https://learn.erthlabs.co/reasons2");
  assert.equal(ad.destination_domain, "learn.erthlabs.co");
  // The snapshot url is the creative handle; there is no direct media url.
  assert.equal(ad.creative_url, row.ad_snapshot_url);
  assert.equal(ad.preview_img_url, null);
  // Still running ⇒ no stop time.
  assert.equal(ad.resume_advertising_flag, true);
  // Engagement/scale have no Meta equivalent for US commercial ads.
  for (const f of ["heat", "impression", "estimated_spend", "like_count", "view_count"] as const) {
    assert.equal(ad[f], null, `${f} must be null`);
  }
});

test("a removed ad yields no creative handle, so no render is attempted", () => {
  const ad = normalizeMetaAd(
    {
      id: "839790995796792",
      page_name: "Holistic Health Finds",
      ad_creative_link_captions: [
        "This ad was run by an account or Page we later disabled for not following our Advertising Standards.",
      ],
      ad_snapshot_url: "https://www.facebook.com/ads/archive/render_ad/?id=839790995796792&access_token=x",
      ad_delivery_start_time: "2026-08-20",
    },
    "MEME",
  );
  assert.equal(ad.creative_url, null);
  assert.equal(ad.landing_page_url, null);
  assert.equal(ad.destination_domain, null);
});
