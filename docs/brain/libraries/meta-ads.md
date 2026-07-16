# `src/lib/meta-ads.ts` — Meta Marketing API ad publishing

The WRITE half of the Meta integration (Graph **v21.0**): list targets + upload video → creative → ad. Reads the per-workspace `ads_management` user token from `meta_connections`. POSTs are **form-encoded** (`metaPost` — `URLSearchParams`, nested objects JSON-stringified; the Marketing API rejects JSON bodies). Replicates the working publisher in the sibling `shopgrowth` repo. See [[../lifecycles/ad-publish]].

## Exports

| Export | Notes |
|---|---|
| `getMetaUserToken(workspaceId)` | decrypt active `meta_connections.access_token_encrypted` (fallback `workspaces.meta_user_access_token_encrypted`) |
| `listAdAccounts(token)` | `/me/adaccounts` |
| `listCampaigns(token, accountId)` | `act_{id}/campaigns` (ACTIVE+PAUSED) |
| `listAdSets(token, accountId, campaignId?)` | `act_{id}/adsets` (filtered by campaign) |
| `listPages(token)` | `/me/accounts` + linked IG → `instagram_user_id` |
| `uploadAdVideo(token, accountId, fileUrl, name)` | `act_{id}/advideos` (`file_url`; Meta downloads) → video_id |
| `waitForVideoReady(token, videoId)` | poll `GET /{video_id}?fields=status` until `video_status='ready'` |
| `uploadAdImage(token, accountId, bytes)` | `act_{id}/adimages` (multipart) → image hash (thumbnails) |
| `getVideoThumbnail(token, videoId)` | `GET /{video_id}/thumbnails` → preferred auto-thumbnail URI |
| `createAdCreative(token, args)` | `act_{id}/adcreatives` → creative_id. **Two shapes by media:** <br>• **Static image = a LINK AD → `object_story_spec.link_data`** (`image_hash`,`link`,`message`=body,`name`=headline,`call_to_action.type`). ⚠️ `image_data` REJECTS the destination link with `meta_400 "The link field is required"` (subcode 2061015) even when `link` is set — verified against Graph v21.0 2026-07-12; this silently broke every static ad. `link_data` carries ONE copy set (no `asset_feed_spec` — it also fails the link check for image link ads), which is exactly the per-test model (one hook per creative). <br>• **Video** — `object_story_spec.video_data` (`video_id`,`image_hash` thumb,`call_to_action.value.link`) + multi-text variations in `asset_feed_spec` (`titles[]`/`bodies[]`, `optimization_type:DEGREES_OF_FREEDOM`, NO `videos`/`ad_formats`/`link_urls`) + `degrees_of_freedom_spec` text-opt OPT_OUT. <br>Both: top-level `url_tags`. |
| `createPlacementCreative(token, args)` | **Battle-tested 2026-07-16 (creative `780957111743379`)** — 3-bucket PLACEMENT-customized STATIC creative: one **portable** (NOT Dynamic Creative) ad that serves feed 4:5, stories/reels 9:16, and right-column 1:1, carrying N titles + N bodies rotated across every placement. Shape: `object_story_spec:{page_id,instagram_user_id}` (page identity only — no `link_data`/`image_data`); `asset_feed_spec.ad_formats:["AUTOMATIC_FORMAT"]` (pinning `SINGLE_IMAGE` flips it to Dynamic Creative → rejected outside a DCO adset); `optimization_type:"PLACEMENT"`; **3 `images`** each `adlabels`-tagged (feed image ALSO carries the `default` label so the priority-4 rule has an asset); `titles`/`bodies` each `adlabels`-tagged to ALL FOUR placement labels so Meta rotates every headline+body per placement; `link_urls:[{website_url,display_url?,adlabels:all}]`; `call_to_action_types:[ctaType]`; **4 `asset_customization_rules`** — feed (p1) FB feed/profile_feed/marketplace + IG stream/explore_home/profile_feed · stories (p2) FB story/facebook_reels/video_feeds + IG story/reels · rightcol (p3) FB `right_hand_column`+search · default (p4) empty spec; `degrees_of_freedom_spec.creative_features_spec.text_optimizations.enroll_status:"OPT_OUT"` (Meta must NOT rewrite our copy). Top-level `url_tags` preserved. Verified by `meta-ads.placement.test.ts`. |
| `createAd(token, accountId, {name,adsetId,creativeId,status})` | `act_{id}/ads` (default PAUSED) → ad_id |
| `updateObjectStatus(token, objectId, status)` | **Iteration Engine 6a** — `POST /{object_id}` `status=ACTIVE\|PAUSED` (ad/adset/campaign); pause/unpause an existing live object |
| `updateObjectBudget(token, objectId, {dailyBudgetCents?,lifetimeBudgetCents?})` | **Iteration Engine 6a** — `POST /{object_id}` `daily_budget`/`lifetime_budget` (cents → integer minor units); scale an adset/campaign on its existing budget field |
| `createCampaign(token, accountId, {name, objective?, abo?, specialAdCategories?, buyingType?, status?, dailyBudgetCents?, lifetimeBudgetCents?})` | **Media-buyer loop** — `act_{id}/campaigns`. Defaults: PAUSED, `OUTCOME_SALES`, `AUCTION`, `special_ad_categories=[]`, ABO (`is_adset_budget_sharing_enabled=false`, no campaign budget — Meta REQUIRES this flag on a budget-less campaign, 2026-07-07). CBO branch (`abo=false`) sets `daily_budget`/`lifetime_budget` in minor units → campaign_id |
| `getOrCreateTestingCampaign(token, accountId)` | **Media-buyer loop** — find-or-create the shared `"MB — Testing (ABO)"` PAUSED ABO campaign by exact name (via `listCampaigns`). Idempotent — the loop parks every new test ad set under this one shared campaign. Exposes `MB_TESTING_CAMPAIGN_NAME` for callers → campaign_id |
| `createAdSet(token, accountId, {name, campaignId, dailyBudgetCents\|lifetimeBudgetCents, pixelId, targeting, optimizationGoal?, billingEvent?, bidStrategy?, bidAmountCents?, customEventType?, startTime?, endTime?, status?})` | **Media-buyer loop** — `act_{id}/adsets`. Purchase-optimized defaults (docs/brain/reference/meta-scaling-methodology.md): PAUSED, `optimization_goal=OFFSITE_CONVERSIONS`, `billing_event=IMPRESSIONS`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `promoted_object={pixel_id, custom_event_type:"PURCHASE"}`. Placements are Advantage+ by default — the ad-set body does NOT force `publisher_platforms`/`*_positions`; pass them via `targeting` only to opt out of automatic placements → adset_id |
| `MB_TESTING_CAMPAIGN_NAME` | Stable name (`"MB — Testing (ABO)"`) for the shared media-buyer testing campaign — export so downstream code doesn't drift on the string |

`META_CTA_TYPES` + `generateMetaCopy` live in `src/lib/ad-meta-copy.ts` (Opus copy gen). Errors throw `meta_{status}: {graph message}`.

`updateObjectStatus`/`updateObjectBudget` are the raw Graph writes behind the autonomous adapters in [[meta__execution]] (Phase 6a) — manage EXISTING live objects only; the engine never sets ACTIVE on a draft/new object.

## Caller

[[../inngest/ad-tool]] `adToolPublishToMeta`; the API routes `/api/ads/meta` + `/api/ads/campaigns/[id]/{meta-copy,publish}`; [[meta__execution]] (`updateObjectStatus`/`updateObjectBudget`, Iteration Engine 6a).

## Gotchas

- `metaGet`/`metaPost` route through [[meta__graph-retry]] `graphFetchJson` —
  transient Meta errors (code 1/2, `is_transient`, 429, 5xx) retry with bounded
  backoff; fatal errors (token/permission/validation) fail fast with
  `error_user_title`/`msg` detail. **The multipart `adimages` upload now routes through `graphFetchJson` as well** — `uploadAdImage` rebuilds a fresh FormData body inside the request thunk on each retry attempt (FormData-backed Blob cannot be reused across fetches) and applies the same bounded transient retry policy ([[../specs/meta-adimage-multipart-retry]] P1).

## Related

[[../lifecycles/ad-publish]] · [[ads__placement-publish]] · [[ads__creative-pack-gate]] · [[../integrations/meta-marketing]] · [[../tables/ad_publish_jobs]] · [[crypto]] · [[meta__graph-retry]]
