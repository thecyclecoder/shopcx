# chargeback_subscription_actions

Per-chargeback log of subscription cancellations/reinstatements.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `chargeback_event_id` | `uuid` | — | → [[chargeback_events]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `action` | `text` | — |  |
| `cancellation_reason` | `text` | ✓ |  |
| `executed_at` | `timestamptz` | — | default: `now()` |
| `executed_by` | `text` | — | default: `'system_auto'` |

## Foreign keys

**Out (this → others):**

- `chargeback_event_id` → [[chargeback_events]].`id`
- `customer_id` → [[customers]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("chargeback_subscription_actions")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("chargeback_subscription_actions")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
