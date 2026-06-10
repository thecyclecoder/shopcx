# social_audience_hours

Per-IG-page audience-online heatmap (hour of day → relative follower activity), feeding the social scheduler's timing optimizer. Refreshed daily from Meta Insights `online_followers`. See [[../lifecycles/social-scheduler]].

**Primary key:** `(meta_page_id, hour)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid | → [[workspaces]] |
| `meta_page_id` | uuid | → [[meta_pages]] (IG account) |
| `hour` | smallint | 0–23 (account-local) |
| `score` | numeric | normalized 0..1 (relative follower activity at that hour) |
| `updated_at` | timestamptz | |

## How it's used

`loadSlotSignals` / `pickBestSlot` in `src/lib/social/optimizer.ts` score each candidate post slot ≈ `(0.5 + score(hour)) × (1 + our-engagement-at(hour, type))`. Before this table is populated, the score defaults neutral (0.5) so slot choice falls back to the configured order. FB audience-online metrics are deprecated, so this is IG-only.

## Related

[[../lifecycles/social-scheduler]] · [[scheduled_social_posts]] · [[../README]]
