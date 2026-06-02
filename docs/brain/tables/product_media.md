# product_media

Per-product media (images, videos) with dimensions and roles (hero, gallery, before/after).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `slot` | `text` | — |  |
| `url` | `text` | ✓ |  |
| `storage_path` | `text` | ✓ |  |
| `alt_text` | `text` | ✓ | default: `''` |
| `width` | `int4` | ✓ |  |
| `height` | `int4` | ✓ |  |
| `file_size` | `int4` | ✓ |  |
| `mime_type` | `text` | ✓ |  |
| `uploaded_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `webp_url` | `text` | ✓ |  |
| `avif_url` | `text` | ✓ |  |
| `webp_storage_path` | `text` | ✓ |  |
| `avif_storage_path` | `text` | ✓ |  |
| `avif_1920_url` | `text` | ✓ |  |
| `webp_1920_url` | `text` | ✓ |  |
| `avif_1920_storage_path` | `text` | ✓ |  |
| `webp_1920_storage_path` | `text` | ✓ |  |
| `avif_480_url` | `text` | ✓ |  |
| `webp_480_url` | `text` | ✓ |  |
| `avif_480_storage_path` | `text` | ✓ |  |
| `webp_480_storage_path` | `text` | ✓ |  |
| `avif_750_url` | `text` | ✓ |  |
| `webp_750_url` | `text` | ✓ |  |
| `avif_750_storage_path` | `text` | ✓ |  |
| `webp_750_storage_path` | `text` | ✓ |  |
| `avif_1080_url` | `text` | ✓ |  |
| `webp_1080_url` | `text` | ✓ |  |
| `avif_1080_storage_path` | `text` | ✓ |  |
| `webp_1080_storage_path` | `text` | ✓ |  |
| `avif_1500_url` | `text` | ✓ |  |
| `webp_1500_url` | `text` | ✓ |  |
| `avif_1500_storage_path` | `text` | ✓ |  |
| `webp_1500_storage_path` | `text` | ✓ |  |
| `display_order` | `int4` | — | default: `0` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_media")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_media")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
