# fraud_rule_matches

Per-(rule, customer/order) rule-trigger events. Drives `fraud_cases` row creation.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `case_id` | `uuid` | — | → [[fraud_cases]].id |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `match_type` | `text` | — |  |
| `match_value` | `text` | — |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `order_id` | `text` | ✓ |  |
| `order_amount_cents` | `int4` | ✓ |  |
| `order_date` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `case_id` → [[fraud_cases]].`id`
- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("fraud_rule_matches")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("fraud_rule_matches")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("fraud_rule_matches")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
