# ad_videos

Rendered media outputs for an [[ad_campaigns|ad campaign]]. One ad = 4 sibling rows (Reels MP4 + Feed-4:5 MP4 + Stories JPG + Feed-4:5 JPG) joined via `format_variant_of_id`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `campaign_id` | `uuid` | — | → [[ad_campaigns]].id |
| `format` | `text` | — | default: `'reels_9x16'` · `reels_9x16` \| `feed_4x5` \| `stories_9x16` |
| `media_kind` | `text` | — | default: `'video'` · `video` \| `static` |
| `format_variant_of_id` | `uuid` | ✓ | → [[ad_videos]].id (SELF) — siblings link to canonical row |
| `final_mp4_url` | `text` | ✓ |  |
| `static_jpg_url` | `text` | ✓ | frame extract, thumbnail only |
| `static_variants` | `jsonb` | — | default: `'[]'` · `[{template_slug, image_url, format}]` |
| `talking_head_url` | `text` | ✓ |  |
| `talking_head_segments_url` | `text[]` | ✓ | 30s ads = 2 clips |
| `audio_url` | `text` | ✓ |  |
| `b_roll_urls` | `jsonb` | — | default: `'[]'` · `[{image_url, video_url, motion_id}]` |
| `transcript_json` | `jsonb` | ✓ | Whisper word timestamps |
| `caption_style` | `text` | ✓ |  |
| `duration_sec` | `int4` | ✓ |  |
| `cost_cents` | `int4` | — | default: `0` |
| `meta` | `jsonb` | — | default: `'{}'` |
| `status` | `text` | — | default: `'pending'` |
| `created_at` | `timestamptz` | — | default: `now()` |

Indexed by `campaign_id` and `workspace_id`.

## Foreign keys

**Out (this → others):**

- `campaign_id` → [[ad_campaigns]].`id`
- `format_variant_of_id` → [[ad_videos]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_videos]].`format_variant_of_id`
- [[ad_jobs]].`video_id`

## Common queries

### Load the 4 sibling rows for a campaign (canonical + variants)
```ts
const { data } = await admin.from("ad_videos")
  .select("id, format, media_kind, format_variant_of_id, final_mp4_url, static_jpg_url, status")
  .eq("workspace_id", workspaceId)
  .eq("campaign_id", campaignId)
  .order("created_at", { ascending: true });
// canonical = format_variant_of_id IS NULL; siblings point at it
```

### Count since a given time
```ts
const { count } = await admin.from("ad_videos")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Enum values are **lowercase** (`format`, `media_kind`, `status`).
- `format_variant_of_id` is **self-referential**: the canonical row has it `NULL`, the 3 format siblings point back at the canonical row. One ad = 4 rows.
- `static_jpg_url` is a frame extract for thumbnails only — real static creatives live in `static_variants[]`.
- 30s ads split talking-head footage into two clips in `talking_head_segments_url[]`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
