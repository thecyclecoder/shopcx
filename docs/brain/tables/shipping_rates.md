# shipping_rates

Storefront shipping rates per (region, weight) — referenced by orders + subscriptions.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `code` | `text` | — |  |
| `applies_to` | `text` | — |  |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `base_cents` | `int4` | — | default: `0` |
| `per_item_cents` | `int4` | — | default: `0` |
| `max_total_cents` | `int4` | ✓ |  |
| `transit_days_min` | `int4` | ✓ |  |
| `transit_days_max` | `int4` | ✓ |  |
| `enabled` | `bool` | — | default: `true` |
| `is_default` | `bool` | — | default: `false` |
| `sort_order` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[orders]].`shipping_rate_id`
- [[subscriptions]].`shipping_rate_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("shipping_rates")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("shipping_rates")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
