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
   - `createAdCreative` → `act_{id}/adcreatives` with `asset_feed_spec` (the headlines × primary texts as a **dynamic creative** Meta optimizes across) + `object_story_spec.page_id`/`instagram_user_id` + CTA + link + UTM `url_tags` → `meta_creative_id` (`status='creating'`).
   - `createAd` → `act_{id}/ads` (`adset_id`, `creative_id`, `status` = PAUSED unless `publish_active`) → `meta_ad_id` (`status='published'`).
   - On any Graph error → `status='failed'` + `error`.
5. The panel shows each job's status + a deep link to the ad in Ads Manager.

## Auth / creds (reuse)

User token with `ads_management` from `meta_connections.access_token_encrypted` (`getMetaUserToken`, falls back to `workspaces.meta_user_access_token_encrypted`). Ad accounts in `meta_ad_accounts`. Graph **v21.0**. POSTs are **form-encoded** (Marketing API rejects JSON bodies). See [[../integrations/meta-marketing]].

## Decisions / gotchas

- **PAUSED by default** — the ad is created in the ad set but `publish_active=false` → `status=PAUSED`; flip it on in Ads Manager (or check "publish active").
- **Pick the page** — `page_id` is operator-selected (`listPages`), NOT the org page (`workspaces.meta_page_id` = *Ashwavana*); ads may run under a different page.
- **Copy variations require a Dynamic Creative ad set.** `asset_feed_spec` with >1 title/body = a dynamic creative; Meta **rejects** it in a regular ad set ("Dynamic Creative ads can only be created under Dynamic Creative Ad Sets"). So `createAdCreative` branches on `isDynamicAdSet(adsetId)`: **dynamic** → `asset_feed_spec` (all variations, `ad_formats:[AUTOMATIC_FORMAT]`); **regular** → single `object_story_spec.video_data` (the FIRST headline + first primary text). To A/B all 4 variations, publish into a Dynamic Creative ad set.
- **Video ads require a thumbnail** — `object_story_spec.video_data` must include `image_url`/`image_hash` or Meta errors "Your ad needs a video thumbnail". We use `getVideoThumbnail` (Meta's own auto-generated preferred thumbnail) after the video is ready.
- **Video** = the campaign's ready `reels_9x16` `final_mp4_url` (re-signed fresh, 6h, for the Meta download). Multi-format (PAC) is deferred.
- **Token expiry** — the connected token expires periodically; reconnect Meta when Graph returns an auth error.
- New Inngest function → needs an **Inngest sync** after deploy (`PUT /api/inngest`) before the first publish, like other new functions.

## Status / open work (2026-06-10)

- Shipped: client + copy gen + job table + routes + Inngest + UI; typechecks; read-side (accounts/campaigns/adsets/pages) verified live.
- Open: multi-format placement customization (upload 4:5 too); per-placement creative; saving/reusing copy on the job; the destination URL default (currently manual — could default to the storefront/product URL).

## Related

[[ad-render]] · [[ad-static]] · [[../integrations/meta-marketing]] · [[../integrations/meta-graph]] · [[../tables/ad_publish_jobs]] · [[../inngest/ad-tool]] · [[../libraries/meta-ads]]
