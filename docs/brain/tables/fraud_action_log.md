# fraud_action_log

Append-only audit of every fraud rule match — what rule, what action taken, what context.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `fraud_case_id` | `uuid` | ✓ | → [[fraud_cases]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `reseller_id` | `uuid` | ✓ | → [[known_resellers]].id |
| `action` | `text` | — |  |
| `metadata` | `jsonb` | ✓ | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `fraud_case_id` → [[fraud_cases]].`id`
- `reseller_id` → [[known_resellers]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("fraud_action_log")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("fraud_action_log")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("fraud_action_log")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
