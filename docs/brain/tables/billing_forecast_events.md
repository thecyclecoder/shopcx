# billing_forecast_events

Append-only events that mutate the static forecast (sub created, cancelled, paused, frequency change, price change). See PERPETUAL-CAMPAIGNS-SPEC.md.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `forecast_id` | `uuid` | — | → [[billing_forecasts]].id |
| `shopify_contract_id` | `text` | — |  |
| `forecast_date` | `date` | — |  |
| `event_type` | `text` | — |  |
| `delta_cents` | `int4` | — | default: `0` |
| `description` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `forecast_id` → [[billing_forecasts]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("billing_forecast_events")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Cross-Shopify boundary lookup
```ts
const { data } = await admin.from("billing_forecast_events")
  .select("*").eq("shopify_contract_id", shopifyId).maybeSingle();
```

### Count since a given time
```ts
const { count } = await admin.from("billing_forecast_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
