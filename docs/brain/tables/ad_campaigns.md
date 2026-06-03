# ad_campaigns

A single ad concept: product × variant × [[product_ad_angles|angle]] × [[ad_avatars|avatar]], plus script and render settings. Each campaign fans out into 4 [[ad_videos]] sibling rows.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | ✓ |  |
| `product_id` | `uuid` | — | → [[products]].id |
| `avatar_id` | `uuid` | ✓ | → [[ad_avatars]].id · ON DELETE SET NULL |
| `variant_id` | `uuid` | ✓ | → [[product_variants]].id |
| `angle_id` | `uuid` | ✓ | → [[product_ad_angles]].id |
| `script_text` | `text` | ✓ |  |
| `length_sec` | `int4` | — | default: `15` · `15` \| `30` |
| `voice_id` | `text` | ✓ |  |
| `caption_style` | `text` | — | default: `'hormozi_yellow'` |
| `vibe_tags` | `text[]` | ✓ |  |
| `hero_image_url` | `text` | ✓ |  |
| `audio_url` | `text` | ✓ |  |
| `status` | `text` | — | default: `'draft'` · `draft` \| `rendering` \| `ready` \| `failed` |
| `created_by` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `angle_id` → [[product_ad_angles]].`id`
- `avatar_id` → [[ad_avatars]].`id`
- `product_id` → [[products]].`id`
- `variant_id` → [[product_variants]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_videos]].`campaign_id`
- [[ad_jobs]].`campaign_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ad_campaigns")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("ad_campaigns")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

## Gotchas

- Enum values are **lowercase** (`status`).
- `avatar_id` is `ON DELETE SET NULL` — archiving/deleting an [[ad_avatars]] row leaves the campaign intact but avatar-less.
- `length_sec` is `15` or `30`. 30s ads render as **two** talking-head clips — see [[ad_videos]].`talking_head_segments_url`.
- Internal joins use UUIDs (`variant_id` → [[product_variants]].id, not `shopify_variant_id`).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
