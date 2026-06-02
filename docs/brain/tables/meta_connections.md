# meta_connections

Per-workspace Meta OAuth state + connected page/instagram accounts.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `access_token_encrypted` | `text` | — | AES-256-GCM |
| `expires_at` | `timestamptz` | ✓ |  |
| `meta_user_id` | `text` | ✓ |  |
| `meta_user_name` | `text` | ✓ |  |
| `is_active` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[meta_ad_accounts]].`meta_connection_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("meta_connections")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("meta_connections")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
