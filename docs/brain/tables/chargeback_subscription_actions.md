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
  .select("id, action, cancellation_reason, executed_at, executed_by")
  .eq("workspace_id", workspaceId)
  .order("executed_at", { ascending: false }).limit(50);
```

### Actions for a chargeback event (primary use case)
```ts
const { data } = await admin.from("chargeback_subscription_actions")
  .select("subscription_id, action, cancellation_reason, executed_at, executed_by")
  .eq("chargeback_event_id", chargebackId)
  .order("executed_at", { ascending: false });
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("chargeback_subscription_actions")
  .select("*").in("customer_id", ids)
  .order("executed_at", { ascending: false });
```

## Gotchas

- Timestamp column is `executed_at`, not `created_at` — there is no `created_at`. `.order("created_at")` throws.
- `action`: `cancelled` / `reinstated` (**lowercase**).
- `cancellation_reason`: `chargeback_fraud` (auto-cancel from `fraudulent` chargeback) / `chargeback_manual` (agent manually cancelled from the dashboard chargeback detail page) / null when `action='reinstated'`.
- `executed_by`: literal `system_auto` for system-triggered actions; workspace_member UUID for manual actions.
- Only `fraudulent` chargebacks trigger `subscriptions_cancelled` auto-action on the parent `chargeback_events` row. `product_not_received` / `credit_not_processed` / `product_unacceptable` get `flagged_for_review` instead — no sub action unless an agent manually cancels.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
