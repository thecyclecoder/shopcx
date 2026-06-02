# daily_order_snapshots

Per-day Shopify orders summary for analytics dashboards.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `snapshot_date` | `date` | — |  |
| `store_timezone` | `text` | — | default: `'America/Chicago'` |
| `recurring_count` | `int4` | — | default: `0` |
| `recurring_revenue_cents` | `int4` | — | default: `0` |
| `new_subscription_count` | `int4` | — | default: `0` |
| `new_subscription_revenue_cents` | `int4` | — | default: `0` |
| `one_time_count` | `int4` | — | default: `0` |
| `one_time_revenue_cents` | `int4` | — | default: `0` |
| `replacement_count` | `int4` | — | default: `0` |
| `replacement_revenue_cents` | `int4` | — | default: `0` |
| `total_count` | `int4` | — | default: `0` |
| `total_revenue_cents` | `int4` | — | default: `0` |
| `shopify_count` | `int4` | ✓ |  |
| `shopify_mismatch` | `bool` | ✓ | default: `false` |
| `utc_start` | `timestamptz` | — |  |
| `utc_end` | `timestamptz` | — |  |
| `computed_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("daily_order_snapshots")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
