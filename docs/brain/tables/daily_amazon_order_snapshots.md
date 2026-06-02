# daily_amazon_order_snapshots

Per-day Amazon orders summary for the ROAS / margin dashboards.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `amazon_connection_id` | `uuid` | — | → [[amazon_connections]].id |
| `snapshot_date` | `date` | — |  |
| `order_bucket` | `text` | — |  |
| `order_count` | `int4` | — | default: `0` |
| `gross_revenue_cents` | `int4` | — | default: `0` |
| `net_revenue_cents` | `int4` | — | default: `0` |
| `currency` | `text` | — | default: `'USD'` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `amazon_connection_id` → [[amazon_connections]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("daily_amazon_order_snapshots")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("daily_amazon_order_snapshots")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
