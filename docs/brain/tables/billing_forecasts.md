# billing_forecasts

Materialized billing-cycle forecast per subscription. Rebuilt from events.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `shopify_contract_id` | `text` | — |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `expected_date` | `date` | — |  |
| `expected_revenue_cents` | `int4` | — | default: `0` |
| `expected_items` | `jsonb` | ✓ | default: `'[]'` |
| `status` | `text` | — | default: `'pending'` |
| `actual_revenue_cents` | `int4` | ✓ |  |
| `collected_at` | `timestamptz` | ✓ |  |
| `failure_reason` | `text` | ✓ |  |
| `change_type` | `text` | ✓ |  |
| `change_note` | `text` | ✓ |  |
| `previous_date` | `date` | ✓ |  |
| `previous_revenue_cents` | `int4` | ✓ |  |
| `source` | `text` | — | default: `'webhook'` |
| `created_from` | `text` | — | default: `'subscription_created'` |
| `order_id` | `text` | ✓ |  |
| `order_number` | `text` | ✓ |  |
| `billing_attempt_id` | `text` | ✓ |  |
| `billing_interval` | `text` | ✓ |  |
| `billing_interval_count` | `int4` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `forecast_type` | `text` | — | default: `'renewal'` |
| `static_revenue_cents` | `int4` | ✓ |  |
| `static_date` | `date` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[billing_forecast_events]].`forecast_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("billing_forecasts")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("billing_forecasts")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("billing_forecasts")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Shopify boundary lookup (webhook ingest only — never for internal joins)
```ts
const { data } = await admin.from("billing_forecasts")
  .select("*").eq("shopify_contract_id", shopifyId).maybeSingle();
```

### Count since a given time
```ts
const { count } = await admin.from("billing_forecasts")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
