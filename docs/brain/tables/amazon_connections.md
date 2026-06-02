# amazon_connections

Per-workspace Amazon Seller Central / SP-API connections (encrypted credentials).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `seller_id` | `text` | — |  |
| `marketplace_id` | `text` | — | default: `'ATVPDKIKX0DER'` |
| `refresh_token_encrypted` | `text` | — | AES-256-GCM |
| `access_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `access_token_expires_at` | `timestamptz` | ✓ |  |
| `seller_name` | `text` | ✓ |  |
| `is_active` | `bool` | — | default: `true` |
| `last_sync_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `client_id_encrypted` | `text` | ✓ | AES-256-GCM |
| `client_secret_encrypted` | `text` | ✓ | AES-256-GCM |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[amazon_asins]].`amazon_connection_id`
- [[amazon_sales_channels]].`amazon_connection_id`
- [[daily_amazon_order_snapshots]].`amazon_connection_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("amazon_connections")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("amazon_connections")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
