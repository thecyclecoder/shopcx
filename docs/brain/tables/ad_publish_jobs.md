# `ad_publish_jobs` — Meta ad publish jobs

One row per "publish this campaign's video to Meta" action: the chosen targets + copy + the resulting Meta ids. Driven by [[../inngest/ad-tool]] `adToolPublishToMeta`. Migration `20260610140000_ad_publish_jobs.sql`. RLS: workspace-member SELECT, service-role write. See [[../lifecycles/ad-publish]].

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
| `created_by` | uuid | |
| `created_at` / `updated_at` | timestamptz | |

## Gotchas

- `meta_*_id` are **bare** Meta ids (strings), not our UUIDs — they cross into the Graph API.
- A `published` row's `meta_ad_id` opens the ad in Ads Manager: `business.facebook.com/adsmanager/manage/ads?act={account}&selected_ad_ids={meta_ad_id}`.
- Default ads are **PAUSED** (`publish_active=false`) — created but not spending.

## Related

[[ad_campaigns]] · [[ad_videos]] · [[../lifecycles/ad-publish]] · [[../libraries/meta-ads]] · [[../integrations/meta-marketing]]
