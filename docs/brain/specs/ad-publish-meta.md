# Spec: publish ads to Meta (Facebook / Instagram)

**Status:** ⏳ planned · **Owner:** Dylan · **Run with:** `/goal do everything in docs/brain/specs/ad-publish-meta.md`

## Why

We can generate finished video ads ([[../lifecycles/ad-render]]) but can't get them into Meta. This adds a **"Publish to Meta"** flow on the campaign page: generate ad copy (headline + 3 variations, primary text + 3 variations, pick a CTA), choose the **ad account → campaign → ad set**, and publish — uploading the video to Meta's ad-video library, building the ad creative, and creating the ad in the chosen ad set.

**Reference implementation:** there's a *working* Meta ad publisher in the sibling repo `/Users/admin/Projects/shopgrowth/lib/inngest/functions/publishAdToMeta.ts` — replicate its Graph API flow (video→creative→ad). Use **Graph API v21.0** (already in `src/lib/meta.ts`), not shopgrowth's v18.0.

## What already exists (reuse, don't rebuild)

- **Meta OAuth + creds**: `meta_connections.access_token_encrypted` (user token with `ads_management`/`ads_read` scope, AES-256-GCM), `meta_ad_accounts` (`meta_account_id`, bare id), `workspaces.meta_page_id` + `meta_instagram_id`. Decrypt via [[../libraries/crypto]].
- **Graph client**: `src/lib/meta.ts` (v21.0, `GRAPH_BASE`) — OAuth + organic social. **No ad publishing** (add it).
- **The asset to publish**: `ad_videos.final_mp4_url` (a signed URL Meta can download via `file_url`) for the campaign's ready `reels_9x16` video. Campaign copy source: `ad_campaigns` (angle, script_text, product) + product intelligence ([[../libraries/ad-angles]] `loadAngleInputs`).
- Brain: [[../integrations/meta-graph]] + [[../integrations/meta-marketing]] (currently read-only).

## The Meta flow (from shopgrowth — replicate)

POSTs are **form-encoded** (`URLSearchParams`; objects `JSON.stringify`'d), token appended as `access_token`. `act_{id}` = `act_` + bare `meta_account_id`.

1. **Upload video** → `POST /act_{id}/advideos` `{ file_url: final_mp4_url, name }` → `{ id: video_id }`. (shopgrowth doesn't poll, but Meta processes async — **poll** `GET /{video_id}?fields=status` until `status.video_status='ready'` before creating the ad, or the ad errors.)
2. **Thumbnail** (optional) → `POST /act_{id}/adimages` (multipart `FormData`, file = a frame/`static_jpg_url`) → `images{}.hash` → use as `image_hash`.
3. **Create creative** → `POST /act_{id}/adcreatives`. For copy variations use `asset_feed_spec` (Meta dynamic creative):
   ```
   { name, object_story_spec: { page_id, instagram_user_id },
     asset_feed_spec: {
       videos: [{ video_id, thumbnail_hash? }],
       titles:  [{text: headline1}, …4],          // headline + 3 variations
       bodies:  [{text: primary1}, …4],            // primary text + 3 variations
       descriptions: [{text}]?,
       call_to_action_types: [ctaType],
       link_urls: [{ website_url: destinationUrl }],
       ad_formats: ["AUTOMATIC_FORMAT"] },
     degrees_of_freedom_spec: { creative_features_spec: { text_optimizations: { enroll_status: "OPT_OUT" } } },
     url_tags: utmString }
   ```
   (Single-copy fallback = `object_story_spec.video_data { video_id, title, message, call_to_action:{type, value:{link}}, image_hash }`.)
4. **Create ad** → `POST /act_{id}/ads` `{ name, adset_id, creative:{creative_id}, status }`. **Default `status="PAUSED"`** so Dylan reviews in Meta before spend (toggle to `ACTIVE`).

## Phases

### Phase 1 — Meta ads client `src/lib/meta-ads.ts` ⏳
- `getMetaUserToken(workspaceId)` — decrypt the active `meta_connections.access_token_encrypted`.
- `listAdAccounts(workspaceId)` (`/me/adaccounts?fields=id,name,account_status,currency` or from `meta_ad_accounts`), `listCampaigns(token, actId)` (`act_{id}/campaigns?fields=id,name,status,objective&effective_status=[ACTIVE,PAUSED]`), `listAdSets(token, actId, campaignId)` (`act_{id}/adsets?fields=id,name,status,campaign_id`).
- `listPages(token)` (`/me/accounts?fields=id,name,instagram_business_account{id,username}`) — **the creative's `page_id` is operator-selected, not the workspace's organic page.** The connected `workspaces.meta_page_id` is the org page (e.g. *Ashwavana*); Amazing Coffee ads may run under a different FB page, so the publish flow lets Dylan pick the page (and its linked IG account becomes `instagram_user_id`).
- `uploadAdVideo(token, actId, fileUrl, name)` + `waitForVideoReady(token, videoId)` (poll), `uploadAdImage(token, actId, bytes)`→hash, `createAdCreative(token, actId, body)`, `createAd(token, actId, body)`. Form-encoded `metaPost` helper. v21.0.
- **Acceptance:** can list accounts/campaigns/adsets + the create helpers typecheck.

### Phase 2 — Ad copy generation `src/lib/ad-meta-copy.ts` ⏳
- `generateMetaCopy(campaign)` → `{ headlines: string[4], primaryTexts: string[4], description? }` via Opus (mirror `ad-script.ts`), grounded in the campaign's angle hook + script + product intelligence (benefits, offer, reviews). Meta limits: headline ≤40 chars ideal, primary text punchy. Direct-response voice (LF8, no banned words from `ad_tool_settings`).
- `META_CTA_TYPES` constant — curated enum (`SHOP_NOW` default, `LEARN_MORE`, `GET_OFFER`, `ORDER_NOW`, `SIGN_UP`, …).
- **Acceptance:** returns 4 headlines + 4 primary texts for Amazing Coffee, on-brand, within limits.

### Phase 3 — Publish-job table ⏳
- Migration `ad_publish_jobs`: `id`, `workspace_id`, `campaign_id`, `video_id`, `meta_account_id`, `meta_campaign_id`, `meta_adset_id`, `meta_page_id`, `meta_instagram_user_id`, `headlines jsonb`, `primary_texts jsonb`, `description`, `cta_type`, `destination_url`, `publish_status` (`queued|uploading|creating|published|failed`), `meta_video_id`, `meta_creative_id`, `meta_ad_id`, `error`, `created_by`, timestamps. RLS (workspace SELECT + service-role) per [[../operational-rules]] § RLS. Apply in-session (`scripts/apply-*`).
- **Acceptance:** table + RLS live.

### Phase 4 — API routes ⏳
- `GET /api/ads/meta/accounts` · `GET /api/ads/meta/campaigns?accountId=` · `GET /api/ads/meta/adsets?accountId=&campaignId=` · `GET /api/ads/meta/pages` (FB pages + linked IG; for the creative `page_id`/`instagram_user_id`). All proxy Graph via the client; workspace-authorized.
- `POST /api/ads/campaigns/[id]/meta-copy` → `generateMetaCopy` (editable in UI).
- `POST /api/ads/campaigns/[id]/publish` `{ video_id, account, campaign, adset, headlines[], primary_texts[], description?, cta_type, destination_url, status }` → insert `ad_publish_jobs` + fire `ad-tool/publish-to-meta`.
- **Acceptance:** dropdowns populate from a live Meta account; publish enqueues a job.

### Phase 5 — Inngest `ad-tool/publish-to-meta` ⏳
- `adToolPublishToMeta`: load job → upload video (`advideos`) → `waitForVideoReady` → optional thumbnail → `createAdCreative` (asset_feed_spec with the copy variants) → `createAd` (PAUSED) → write `meta_video_id`/`meta_creative_id`/`meta_ad_id` + `publish_status='published'` (or `failed` + `error`). Concurrency-keyed per workspace; surface Graph errors verbatim.
- **Acceptance:** a real ad lands in the chosen ad set (PAUSED), visible in Meta Ads Manager, job row → `published` with `meta_ad_id`.

### Phase 6 — UI: "Publish to Meta" on the campaign page ⏳
- Panel on `/dashboard/marketing/ads/[id]`: **Generate copy** → editable list of 4 headlines + 4 primary texts (+ optional description) + **CTA** select + **destination URL** (default the storefront/product URL + UTM tokens) → **Facebook Page** select (drives `page_id` + its IG account) → cascading **Ad account → Campaign → Ad set** selects → **Publish** (PAUSED default, with a "publish active" checkbox). Show job status + a deep link to the ad in Ads Manager.
- **Acceptance:** Dylan publishes an ad end-to-end from the dashboard.

### Phase 7 — Brain docs + fold ⏳
- New [[../lifecycles/ad-publish]] (the publish flow) + `libraries/meta-ads` + `libraries/ad-meta-copy`; update [[../integrations/meta-marketing]] (now WRITES ads), new `tables/ad_publish_jobs`. Update [[../inngest/ad-tool]]. Delete this spec.

## Decisions / notes
- **Default PAUSED** — never auto-spend; Dylan flips to active in Ads Manager (or the active checkbox).
- **Copy variations** ride in `asset_feed_spec` (Meta optimizes across the 4 headlines × 4 bodies) — matches the "+3 variations" ask. Single-copy `object_story_spec` is the fallback.
- **Video** = the campaign's ready `reels_9x16` `final_mp4_url` (signed; Meta downloads it). Later: also upload `feed_4x5` for placement customization (shopgrowth's PAC pattern) — deferred.
- **Destination URL** defaults to the store/product URL; append UTM (`campaign`/`ad`/`angle`).
- **Scopes**: needs `ads_management` — **verified present** on the connected token (along with `ads_read`, `business_management`); token expires **2026-06-30** (reconnect before then).
- **Pick the page**: the creative `page_id` is operator-selected via `listPages` (don't hard-code `workspaces.meta_page_id` — that's the org *Ashwavana* page; ads may run under a different page). The selected page's linked `instagram_business_account` → `instagram_user_id`. Persist the chosen `page_id`/`instagram_user_id` on the publish job.
- **No new Meta app** — reuse the existing connection + `meta_ad_accounts` (Amazing Coffee & Creamer = `act_2352876514967984`).

## Definition of done
From a campaign on `/dashboard/marketing/ads/[id]`, Dylan generates copy (4 headlines + 4 primary texts + CTA), picks ad account/campaign/ad set, and publishes — the video uploads to Meta, a creative + ad are created (PAUSED) in the ad set, and the `meta_ad_id` + Ads Manager link surface. Brain updated; spec folded + deleted.
