# meta_post_cache

Cached Meta post/ad metadata for comment context (text, image, ad attribution).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_page_id` | `uuid` | — | → [[meta_pages]].id |
| `meta_post_id` | `text` | — |  |
| `is_ad` | `bool` | — | default: `false` |
| `ad_id` | `text` | ✓ |  |
| `permalink_url` | `text` | ✓ |  |
| `message` | `text` | ✓ |  |
| `image_url` | `text` | ✓ |  |
| `video_url` | `text` | ✓ |  |
| `posted_at` | `timestamptz` | ✓ |  |
| `extracted_urls` | `text[]` | — | default: `'{}'` |
| `matched_product_id` | `uuid` | ✓ | → [[products]].id |
| `last_refreshed_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `matched_product_id` → [[products]].`id`
- `meta_page_id` → [[meta_pages]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("meta_post_cache")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

- Holds `effective_object_story_id` for ad-served posts — canonical attribution back to the ad creative. See project_meta_comments_ad_detection.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
