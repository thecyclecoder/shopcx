# Lifecycle: publish ads to Meta (Facebook / Instagram)

Takes a finished campaign video ([[ad-render]]) and publishes it as a Meta ad: generate copy, pick the page + ad account + campaign + ad set, upload the video, build the creative, create the ad. **Default PAUSED** so nothing spends until reviewed in Ads Manager. The WRITE half of the Meta integration (the rest of [[../integrations/meta-marketing]] is read-only spend/insights).

**Code:** `src/lib/meta-ads.ts` (Graph client) · `src/lib/ad-meta-copy.ts` (copy gen) · `src/lib/inngest/ad-tool.ts` (`adToolPublishToMeta`) · [[../tables/ad_publish_jobs]]. **UI:** "Publish to Meta" panel on `/dashboard/marketing/ads/[id]`.

## Flow

1. **Generate copy** — `POST /api/ads/campaigns/[id]/meta-copy` → `generateMetaCopy` (Opus, from the campaign's angle + script + product intelligence) → **4 headlines + 4 primary texts + a description**, editable in the panel. Pick a **CTA** (`META_CTA_TYPES`) + **destination URL**.
2. **Pick targets** — selectors hit `GET /api/ads/meta?resource=accounts|pages|campaigns|adsets` (proxy Graph via the user token). **Facebook Page** (its linked IG account → `instagram_user_id`), **ad account → campaign → ad set** (cascading).
3. **Publish** — `POST /api/ads/campaigns/[id]/publish` inserts an [[../tables/ad_publish_jobs]] row (`queued`) + fires `ad-tool/publish-to-meta`.
4. **`adToolPublishToMeta`** (Inngest):
   - `uploadAdVideo` → `act_{id}/advideos` (`file_url` = a fresh signed URL of `ad_videos.meta.storage_path`; Meta downloads it) → `meta_video_id` (`status='uploading'`).
   - `waitForVideoReady` — poll `GET /{video_id}?fields=status` until `video_status='ready'` (Meta processes async; skipping this errors the ad).
   - `createAdCreative` → `act_{id}/adcreatives` with `asset_feed_spec` (all headlines as `titles[]` × all primary texts as `bodies[]` — a **non-dynamic multi-text** creative, "Add text/headline option") + `object_story_spec.page_id`/`instagram_user_id` + CTA + link in `link_urls` + UTM `url_tags` → `meta_creative_id` (`status='creating'`).
   - `createAd` → `act_{id}/ads` (`adset_id`, `creative_id`, `status` = PAUSED unless `publish_active`) → `meta_ad_id` (`status='published'`).
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
- **Static (image) ads** (cold-50+ killer statics, [[../specs/killer-statics]]) — `adToolPublishToMeta` branches on `ad_videos.media_kind`. For `static` it fetches the JPG → `uploadAdImage` → image hash → `createAdCreative({ imageHash })`, which builds `object_story_spec.image_data` (image + CTA link) instead of `video_data` — no video upload, no thumbnail. The publish route dropped the `media_kind='video'` filter so it auto-selects the latest ready media of either kind; the per-ad destination pre-fills from [[../tables/ad_campaigns]] `landing_url`. Everything else (asset_feed_spec text variations, `url_tags`, OPT_OUT) is identical to video.
- **Video** = the campaign's ready `reels_9x16` `final_mp4_url` (re-signed fresh, 6h, for the Meta download). Multi-format (PAC) is deferred.
- **Token expiry** — the connected token expires periodically; reconnect Meta when Graph returns an auth error.
- New Inngest function → needs an **Inngest sync** after deploy (`PUT /api/inngest`) before the first publish, like other new functions.

## Status / open work (2026-06-10)

- Shipped: client + copy gen + job table + routes + Inngest + UI; typechecks; read-side (accounts/campaigns/adsets/pages) verified live.
- Open: multi-format placement customization (upload 4:5 too); per-placement creative; saving/reusing copy on the job; the destination URL default (currently manual — could default to the storefront/product URL).

## Related

[[ad-render]] · [[ad-static]] · [[../integrations/meta-marketing]] · [[../integrations/meta-graph]] · [[../tables/ad_publish_jobs]] · [[../inngest/ad-tool]] · [[../libraries/meta-ads]]
