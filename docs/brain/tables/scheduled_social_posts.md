# scheduled_social_posts

The social scheduler's content calendar — one row per planned/published organic post to a FB page or IG account. See [[../lifecycles/social-scheduler]].

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | → [[workspaces]] |
| `meta_page_id` | uuid | → [[meta_pages]] (the FB page / IG account) |
| `platform` | text | `facebook` \| `instagram` |
| `post_type` | text | `feed` \| `reel` \| `story` \| `carousel` |
| `source_kind` | text | `avatar` \| `ad_video` \| `testimonial` \| `resource` \| `blog` \| `promo` \| `organic` |
| `source_ref_id` | uuid | campaign_id / ad_video_id / post_id / **[[organic_content]].id** (when `source_kind='organic'`) |
| `product_id` | uuid | → [[products]] (PI source for the caption; null for non-product resources) |
| `media_bucket`, `media_path` | text | private-bucket asset — **re-signed at publish** |
| `media_url` | text | public asset (resource / blog images) |
| `link_url` | text | blog posts only — public article URL → **FB link card** (`/feed {message, link}`); ignored on IG |
| `caption` | text | generated copy (ignored for stories — media-only) |
| `scheduled_at` | timestamptz | when the publisher fires |
| `status` | text | `draft` \| `scheduled` \| `publishing` \| `posted` \| `failed` \| `skipped` \| `cancelled` |
| `published_platform_id`, `published_permalink`, `published_at` | | publish result |
| `error` | text | failure detail |
| `reach`/`likes`/`comments`/`saves`/`shares`/`engagement` | int | Meta Insights (Phase 5) |
| `metrics_synced_at` | timestamptz | last insights pull |
| `created_by` | text | `system` \| user id |

## Gotchas

- **Organic is separate from ads (organic-nugget-engine Phase 1).** `source_kind='organic'` rows point `source_ref_id` at [[organic_content]].id — the poster's organic content comes from that library, never ad_campaigns / ad_videos. Review highlights now render into [[organic_content]] (format=`review`), not the old fake "Reviews" ad campaigns. `post_type='carousel'` is a 2–10 slide nugget slideshow (publisher support lands in Phase 2).
- **Reuse rotation reads this table** (last `min_resource_reuse_days`, default 21) to avoid re-posting the same `source_ref_id` — there is no separate usage table.
- `require_approval` rows land as `draft` and fire no publish event until approved in the dashboard.
- The publisher **re-reads the row at fire time**, so dashboard edits (caption/time) and cancels take effect.

## Related

[[../lifecycles/social-scheduler]] · [[social_campaigns]] · [[social_audience_hours]] · [[meta_pages]] · [[../README]]
