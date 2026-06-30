# ready-to-test

Queries the **ready-to-test queue** — creatives produced by [[ad-static]], [[ad-render]], or [[../lifecycles/creative-finder]] that are finished but not yet launched into an active ad set. Used by the Growth director to supervise + approve creative promotions before they spend.

**Code:** `src/lib/ads/ready-to-test.ts` · **Function:** `listReadyToTest(admin, {workspaceId})` → `{ readyToTest[]: { ad_campaign_id, archetype, lander_url, status:'ready_no_active_ad', formats:string[], created_at } }`

## Behavior

Returns every `ad_campaigns` row that has:
- ≥1 `ad_videos` with `status='ready'` (or `media_kind='static'` final JPG), AND
- `landing_url` set, AND
- NO active `ad_publish_jobs` row in `status in ('queued','uploading','creating','published')`

The reader is **pure read** — no schema changes, no writes. It surfaces candidates for the Director-approval flow ([[../lifecycles/ad-publish]] "promote ready to test").

## Cross-links

[[ad-static]] · [[ad-render]] · [[../lifecycles/creative-finder]] · [[../lifecycles/ad-publish]] · [[../functions/growth]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_publish_jobs]]
