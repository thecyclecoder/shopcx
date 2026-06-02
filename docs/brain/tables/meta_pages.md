# meta_pages

Meta Pages connected for inbound DM + comment management.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `platform` | `text` | — |  |
| `meta_page_id` | `text` | — |  |
| `meta_page_name` | `text` | ✓ |  |
| `meta_instagram_id` | `text` | ✓ |  |
| `page_type` | `text` | — | default: `'brand'` |
| `ai_moderate_ad_comments` | `bool` | — | default: `true` |
| `ai_moderate_organic_comments` | `bool` | — | default: `true` |
| `access_token_encrypted` | `text` | — | AES-256-GCM |
| `webhook_verify_token` | `text` | ✓ |  |
| `is_active` | `bool` | — | default: `true` |
| `connected_at` | `timestamptz` | — | default: `now()` |
| `last_synced_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[meta_post_cache]].`meta_page_id`
- [[social_comments]].`meta_page_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("meta_pages")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("meta_pages")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
