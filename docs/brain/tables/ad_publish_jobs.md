# `ad_publish_jobs` — Meta ad publish jobs

One row per "publish this campaign's video to Meta" action: the chosen targets + copy + the resulting Meta ids. Driven by [[../inngest/ad-tool]] `adToolPublishToMeta`. Migrations `20260610140000_ad_publish_jobs.sql` + `20260620180000_ad_publish_jobs_engine_fields.sql` (Iteration Engine 6b: `ad_name` + `recommendation_id`) + `20260707120000_media_buyer_test_cohorts.sql` (Media Buyer Phase 1: `origin`). RLS: workspace-member SELECT, service-role write. See [[../lifecycles/ad-publish]].

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` / `campaign_id` | uuid → workspaces / [[ad_campaigns]] | cascade |
| `video_id` | uuid → [[ad_videos]] | the rendered video published |
| `meta_account_id` | text | bare ad-account id (client adds `act_`) |
| `meta_campaign_id` | text | Meta campaign (optional context) |
| `meta_adset_id` | text | the ad set the ad is created in |
| `meta_page_id` | text | operator-selected FB page for the creative |
| `meta_instagram_user_id` | text | the page's linked IG account |
| `headlines` | jsonb | headline + variations |
| `primary_texts` | jsonb | primary text + variations |
| `description` | text | optional link description |
| `cta_type` | text | Meta CTA enum (default `SHOP_NOW`) |
| `destination_url` | text | click-through URL |
| `publish_active` | bool | false → ad created PAUSED |
| `publish_status` | text | `queued` → `uploading` → `creating` → `published` \| `failed` |
| `meta_video_id` / `meta_creative_id` / `meta_ad_id` | text | results from the Graph calls |
| `error` | text | failure reason |
| `ad_name` | text | **6b** — explicit ad/creative name; the publisher prefers it over `ad_campaigns.name`, so engine drafts carry the `[ie]` marker without renaming the operator's campaign |
| `recommendation_id` | uuid → [[iteration_recommendations]] | **6b** — the recommendation this job fulfills; on publish the meta ids are written back to it (`status='executed'`/`failed`) |
| `origin` | text | **media-buyer-test-winner-loop Phase 1** — the CALLER of the publish. `null`/`'operator'` = studio/human path (unchanged). `'media-buyer-test'` = the Media Buyer agent's autonomous go-live rail, gated by [[../libraries/media-buyer-publish-gate]] against [[media_buyer_test_cohorts]] before `publish_active=true` can survive. |
| `created_by` | uuid | |
| `created_at` / `updated_at` | timestamptz | |

## Gotchas

- `meta_*_id` are **bare** Meta ids (strings), not our UUIDs — they cross into the Graph API.
- A `published` row's `meta_ad_id` opens the ad in Ads Manager: `business.facebook.com/adsmanager/manage/ads?act={account}&selected_ad_ids={meta_ad_id}`.
- Default ads are **PAUSED** (`publish_active=false`) — created but not spending. Iteration Engine 6b ([[../libraries/meta__recommendation-execute]]) always sets `publish_active=false`.
- **`origin='media-buyer-test'` opts INTO the autonomous go-live gate** ([[../libraries/media-buyer-publish-gate]]). Both the publish route AND the publisher re-check the gate before an ACTIVE ad can be created — a wrong ad set or over-ceiling projection DOWNGRADES `publish_active=false` + escalates. A `null` or `'operator'` origin skips the gate entirely.

## Related

[[ad_campaigns]] · [[ad_videos]] · [[iteration_recommendations]] · [[media_buyer_test_cohorts]] · [[../lifecycles/ad-publish]] · [[../libraries/meta-ads]] · [[../libraries/media-buyer-publish-gate]] · [[../libraries/meta__recommendation-execute]] · [[../integrations/meta-marketing]]
