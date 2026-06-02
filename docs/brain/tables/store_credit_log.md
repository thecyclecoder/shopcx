# store_credit_log

Per-customer store credit ledger — issued, used, expired. Backed by Shopify storeCreditAccount.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `shopify_customer_id` | `text` | — |  |
| `type` | `text` | — |  |
| `amount` | `numeric` | — |  |
| `currency` | `text` | — | default: `'USD'` |
| `reason` | `text` | ✓ |  |
| `issued_by` | `uuid` | — | → [[workspace_members]].id |
| `issued_by_name` | `text` | — |  |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `subscription_id` | `text` | ✓ |  |
| `shopify_transaction_id` | `text` | ✓ |  |
| `balance_after` | `numeric` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `issued_by` → [[workspace_members]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("store_credit_log")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("store_credit_log")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Shopify boundary lookup (webhook ingest only — never for internal joins)
```ts
const { data } = await admin.from("store_credit_log")
  .select("*").eq("shopify_customer_id", shopifyId).maybeSingle();
```

### Rows for a ticket
```ts
const { data } = await admin.from("store_credit_log")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("store_credit_log")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
