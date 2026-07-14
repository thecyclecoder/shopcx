# Lifecycle: publish ads to Meta (Facebook / Instagram)

Takes a finished campaign video ([[ad-render]]) and publishes it as a Meta ad: generate copy, pick the page + ad account + campaign + ad set, upload the video, build the creative, create the ad. **Default PAUSED** so nothing spends until reviewed in Ads Manager. The WRITE half of the Meta integration (the rest of [[../integrations/meta-marketing]] is read-only spend/insights).

**Code:** `src/lib/meta-ads.ts` (Graph client) · `src/lib/ad-meta-copy.ts` (copy gen) · `src/lib/inngest/ad-tool.ts` (`adToolPublishToMeta`) · [[../tables/ad_publish_jobs]]. **UI:** "Publish to Meta" panel on `/dashboard/marketing/ads/[id]`.

## Flow

1. **Generate copy** — `POST /api/ads/campaigns/[id]/meta-copy` → `generateMetaCopy` (Opus, from the campaign's angle + script + product intelligence) → **4 headlines + 4 primary texts + a description**, editable in the panel. Pick a **CTA** (`META_CTA_TYPES`) + **destination URL**.
2. **Pick targets** — selectors hit `GET /api/ads/meta?resource=accounts|pages|campaigns|adsets` (proxy Graph via the user token). **Facebook Page** (its linked IG account → `instagram_user_id`), **ad account → campaign → ad set** (cascading).
3. **Publish** — `POST /api/ads/campaigns/[id]/publish` inserts an [[../tables/ad_publish_jobs]] row (`queued`) + fires `ad-tool/publish-to-meta`.
   - **Media-Buyer test-cohort gate** (media-buyer-test-winner-loop Phase 1). A publish body with `origin='media-buyer-test'` opts INTO the autonomous go-live rail. The route calls [[../libraries/media-buyer-publish-gate]] `evaluateMediaBuyerTestPublish` BEFORE insert: on ALLOW (in-cohort + under-ceiling) it keeps `publish_active=true` and pins the ad-set's `daily_budget` to the cohort ceiling via [[../libraries/meta-ads]] `updateObjectBudget`; on REFUSE (`no_active_cohort` | `wrong_adset` | `over_ceiling`) it forces `publish_active=false` and calls `escalateMediaBuyerTestPublishRefusal` → CEO Approval Request + growth `director_activity` `media_buyer_test_gate_refused`. Non-media-buyer origins skip the gate entirely — the studio path is unchanged.
4. **`adToolPublishToMeta`** (Inngest):
   - `uploadAdVideo` → `act_{id}/advideos` (`file_url` = a fresh signed URL of `ad_videos.meta.storage_path`; Meta downloads it) → `meta_video_id` (`status='uploading'`).
   - `waitForVideoReady` — poll `GET /{video_id}?fields=status` until `video_status='ready'` (Meta processes async; skipping this errors the ad).
   - `createAdCreative` → `act_{id}/adcreatives` with `asset_feed_spec` (all headlines as `titles[]` × all primary texts as `bodies[]` — a **non-dynamic multi-text** creative, "Add text/headline option") + `object_story_spec.page_id`/`instagram_user_id` + CTA + link in `link_urls` + UTM `url_tags` → `meta_creative_id` (`status='creating'`).
   - **Belt-and-suspenders re-check of the Media-Buyer gate** — before `createAd`, if the job's `origin='media-buyer-test'` AND `publish_active=true`, re-run `evaluateMediaBuyerTestPublish` against the loaded job. On a refusal (a cohort retired between insert and publish, or a script that bypassed the route) DOWNGRADE `publish_active=false` (written back to the job row) + escalate (idempotent — same dedupe key as the route). The ad still ships, just PAUSED. Never silently spend.
   - `createAd` → `act_{id}/ads` (`adset_id`, `creative_id`, `status` = PAUSED unless the effective `publish_active` after the re-check is true) → `meta_ad_id` (`status='published'`).
   - On any Graph error → `status='failed'` + `error`.
5. The panel shows each job's status + a deep link to the ad in Ads Manager.

## Auth / creds (reuse)

User token with `ads_management` from `meta_connections.access_token_encrypted` (`getMetaUserToken`, falls back to `workspaces.meta_user_access_token_encrypted`). Ad accounts in `meta_ad_accounts`. Graph **v21.0**. POSTs are **form-encoded** (Marketing API rejects JSON bodies). See [[../integrations/meta-marketing]].

## Decisions / gotchas

- **PAUSED by default** — the ad is created in the ad set but `publish_active=false` → `status=PAUSED`; flip it on in Ads Manager (or check "publish active").
- **Pick the page** — `page_id` is operator-selected (`listPages`), NOT the org page (`workspaces.meta_page_id` = *Ashwavana*); ads may run under a different page.
- **Copy variations DON'T require a Dynamic Creative ad set** — but the exact creative shape matters, and it's account-specific. The shape **confirmed working on our account** (a live test publish into the regular "F – 50-65+" ad set, many ads coexisting):
  - **Video + link + CTA in `object_story_spec.video_data`** (`video_id`, `image_hash` thumbnail, `call_to_action.value.link`).
  - **The headline/primary-text variations in `asset_feed_spec`** as `titles[]`/`bodies[]` with **`optimization_type: "DEGREES_OF_FREEDOM"`** — Meta's "multiple text options" mode.
  - **NO `videos[]`, NO `ad_formats`, NO `link_urls`, NO `asset_customization_rules` in the feed** — any of those flips it to Dynamic Creative → "Dynamic Creative ads can only be created under Dynamic Creative Ad Sets" at **ad** create. `createAdCreative` therefore has no `isDynamicAdSet` branch.
  - The shopgrowth shape (a `videos[]` feed with no `ad_formats`) works on accounts that auto-infer the format; ours rejects it ("an asset feed can have exactly one ad format"), and pinning `ad_formats:[SINGLE_VIDEO]` lets the creative build but then the **ad** is dynamic-rejected. Hence the video-in-`object_story_spec` shape above.
- **Link must be in `object_story_spec.video_data.call_to_action.value.link`** — not a top-level `link`, not `asset_feed_spec.link_urls` (with `DEGREES_OF_FREEDOM` that errors "The link field is required", subcode 2061015). UTM tracking rides the top-level **`url_tags`** (shows up as the ad's "URL parameters").
- **`text_optimizations: OPT_OUT`** in `degrees_of_freedom_spec` = the "Optimize text per person: Disabled" toggle — Meta tests the options but doesn't personalize/rewrite them.
- **Video ads require a thumbnail** — `object_story_spec.video_data.image_hash`. We pull Meta's auto-generated thumbnail (`getVideoThumbnail`) once the video is ready, re-upload it via `uploadAdImage` to get a hash, and attach it. (subcode 2490433 "Something went wrong" can mean a missing thumbnail or an unready video — `waitForVideoReady` covers the latter.)
- **Static (image) ads** (cold-50+ killer statics, [[../specs/killer-statics]]) — `adToolPublishToMeta` branches on `ad_videos.media_kind`. For `static` it fetches the JPG → `uploadAdImage` → image hash → `createAdCreative({ imageHash })` → `object_story_spec.image_data`. **`image_data` REQUIRES a top-level `link`** (the destination URL) — the CTA link alone errors "The link field is required" (unlike `video_data`, which doesn't need it). The publish route dropped the `media_kind='video'` filter; the per-ad destination pre-fills from [[../tables/ad_campaigns]] `landing_url`.
- **Both ratios → ONE placement-customized ad (PAC)** — `adToolPublishToMeta` gathers BOTH the campaign's ready formats (`feed_4x5` + `reels_9x16`/`stories_9x16`), uploads both (videos → ids, statics → hashes), and calls **`createDualAssetCreative`**: `object_story_spec` (page only) + `asset_feed_spec` with `ad_formats:["AUTOMATIC_FORMAT"]` + `optimization_type:"PLACEMENT"` + placement-labeled assets + `asset_customization_rules` (**feed→4:5, stories/reels→9:16, default→9:16**). Mirrors the proven shopgrowth dual-asset shape — `AUTOMATIC_FORMAT` (not `SINGLE_VIDEO`) is what lets PAC publish into a **regular** ad set without the Dynamic-Creative rejection. Falls back to the single-asset `object_story_spec` path when only one ratio is ready.
- **Token expiry** — the connected token expires periodically; reconnect Meta when Graph returns an auth error.
- New Inngest function → needs an **Inngest sync** after deploy (`PUT /api/inngest`) before the first publish, like other new functions.
- **`utm_content={{ad.id}}` + `?angle=&variant=` are REQUIRED, not optional** (attribution-sensor-recalibration Phase 2). The `url_tags` string on every creative includes `utm_content={{ad.id}}` — Meta's dynamic-URL token, substituted with the real ad id at click time; without it, `orders.attributed_utm_content` can't resolve to `meta_ad_id` and the attribution sensor loses its ad grain. The publish route enforces a **scent-match invariant** on `destination_url`: after the operator/campaign-landing_url/advertorialLanderUrl fallback resolves, `hasScentMatchParams(url)` gates a second call to `advertorialLanderUrl(workspaceId, campaignId, variant)` + `appendScentMatchParams(destination, lander)` (both in [[../libraries/advertorial-pages]]) so the final URL ALWAYS carries `?angle=&variant=`. A bare PDP click without those params → the Phase-2 sensor buckets to `(unresolved)` and per-creative ROAS goes dark. The resolved URL is persisted back to [[../tables/ad_publish_jobs]] `destination_url`.

## Director-approved ready-to-test promotion (2026-06-30)

The Growth director can now queue ready-to-test creatives ([[../libraries/ready-to-test]]) for publish with `publish_active=false`, creating **PAUSED Meta ads** awaiting manual activation in Ads Manager. On Director approval, the worker fires `ad-tool/publish-to-meta` with the PAUSED flag, stamps a `promoted_ready_to_test` row in [[director_activity]], and after publish completes, writes an `attributed_creative_outcome` row linking the creative's ROAS back to the promotion decision (via [[../tables/meta_attribution_daily]] settled outcomes ≥3d later).

## Status / open work (2026-06-30)

- Shipped: client + copy gen + job table + routes + Inngest + UI; typechecks; read-side (accounts/campaigns/adsets/pages) verified live; ready-to-test promotion + Director approval + outcome lineage.
- Open: multi-format placement customization (upload 4:5 too); per-placement creative; saving/reusing copy on the job; the destination URL default (currently manual — could default to the storefront/product URL).

## Related

[[ad-render]] · [[ad-static]] · [[../integrations/meta-marketing]] · [[../integrations/meta-graph]] · [[../tables/ad_publish_jobs]] · [[../tables/media_buyer_test_cohorts]] · [[../inngest/ad-tool]] · [[../libraries/meta-ads]] · [[../libraries/media-buyer-publish-gate]] · [[../libraries/ready-to-test]] · [[../libraries/ads-supervisor]] · [[../inngest/ads-supervisor-cadence]] · [[director_activity]]
