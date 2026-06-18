# meta_ad_accounts

Meta Ads accounts connected to the workspace.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_connection_id` | `uuid` | — | → [[meta_connections]].id |
| `meta_account_id` | `text` | — |  |
| `meta_account_name` | `text` | — |  |
| `currency` | `text` | ✓ | default: `'USD'` |
| `timezone` | `text` | ✓ | default: `'America/Chicago'` |
| `is_active` | `bool` | — | default: `true` |
| `last_sync_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `meta_connection_id` → [[meta_connections]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[daily_meta_ad_spend]].`meta_ad_account_id`
- [[meta_campaigns]].`meta_ad_account_id`
- [[meta_adsets]].`meta_ad_account_id`
- [[meta_ads]].`meta_ad_account_id`
- [[meta_insights_daily]].`meta_ad_account_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("meta_ad_accounts")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("meta_ad_accounts")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
