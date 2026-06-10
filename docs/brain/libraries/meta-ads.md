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
| `createAdCreative(token, args)` | `act_{id}/adcreatives` — **non-dynamic multi-text** creative: video+link+CTA in `object_story_spec.video_data` (`video_id`,`image_hash`,`call_to_action.value.link`) + variations in `asset_feed_spec` (`titles[]`/`bodies[]`, `optimization_type:DEGREES_OF_FREEDOM`, NO `videos`/`ad_formats`/`link_urls`) + `degrees_of_freedom_spec` text-opt OPT_OUT + top-level `url_tags` → creative_id |
| `createAd(token, accountId, {name,adsetId,creativeId,status})` | `act_{id}/ads` (default PAUSED) → ad_id |

`META_CTA_TYPES` + `generateMetaCopy` live in `src/lib/ad-meta-copy.ts` (Opus copy gen). Errors throw `meta_{status}: {graph message}`.

## Caller

[[../inngest/ad-tool]] `adToolPublishToMeta`; the API routes `/api/ads/meta` + `/api/ads/campaigns/[id]/{meta-copy,publish}`.

## Related

[[../lifecycles/ad-publish]] · [[../integrations/meta-marketing]] · [[../tables/ad_publish_jobs]] · [[crypto]]
