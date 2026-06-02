# payment_failures

Per-attempt log within a dunning cycle — card tried, result, attempt type (initial/card_rotation/payday_retry/new_card_retry).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `shopify_contract_id` | `text` | — |  |
| `billing_attempt_id` | `text` | ✓ |  |
| `payment_method_last4` | `text` | ✓ |  |
| `payment_method_id` | `text` | ✓ |  |
| `error_code` | `text` | ✓ |  |
| `error_message` | `text` | ✓ |  |
| `attempt_number` | `int4` | — | default: `1` |
| `attempt_type` | `text` | — |  |
| `succeeded` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("payment_failures")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("payment_failures")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Cross-Shopify boundary lookup
```ts
const { data } = await admin.from("payment_failures")
  .select("*").eq("shopify_contract_id", shopifyId).maybeSingle();
```

### Count since a given time
```ts
const { count } = await admin.from("payment_failures")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `attempt_type`: `initial` / `card_rotation` / `payday_retry` / `new_card_retry`.
- Per-attempt — distinct from `dunning_cycles` which is per-billing-cycle aggregate.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
