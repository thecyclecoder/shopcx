# transactions

Per-(order, customer, subscription) Braintree transaction log — type, amount, status, processor response. attempted_at / settled_at / refunded_at.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `payment_method_id` | `uuid` | ✓ | → [[customer_payment_methods]].id |
| `order_id` | `uuid` | ✓ | → [[orders]].id |
| `type` | `text` | — | default: `'initial_checkout'` |
| `status` | `text` | — | default: `'pending'` |
| `amount_cents` | `int8` | — |  |
| `currency` | `text` | — | default: `'USD'` |
| `braintree_transaction_id` | `text` | ✓ |  |
| `braintree_payment_method_token` | `text` | ✓ |  |
| `braintree_customer_id` | `text` | ✓ |  |
| `processor_response_code` | `text` | ✓ |  |
| `processor_response_text` | `text` | ✓ |  |
| `error_message` | `text` | ✓ |  |
| `attempted_at` | `timestamptz` | — | default: `now()` |
| `settled_at` | `timestamptz` | ✓ |  |
| `refunded_at` | `timestamptz` | ✓ |  |
| `metadata` | `jsonb` | — | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `order_id` → [[orders]].`id`
- `payment_method_id` → [[customer_payment_methods]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("transactions")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("transactions")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("transactions")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("transactions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **`type`**: guarded by `CHECK (type IN ('initial_checkout','renewal','dunning_retry','manual','comp'))` (`transactions_type_check`). It's `TEXT`+`CHECK`, not a pg enum, so widening it is a one-shot drop-then-add (`20260622170000_comp_transaction_type.sql` added `'comp'` for [[../specs/comp-subscriptions]]'s free $0 ledger rows; the original four come from `20260520160000_transactions.sql`). Production data is mostly `initial_checkout` — the storefront checkout + internal-sub scheduler are still ramping. Probe before filtering. Any NEW type value must extend this CHECK in the same migration, or every insert silently violates the constraint.
- **`status`**: `succeeded` is what's stored on success (NOT `settled`). Failures get `failed`. `pending` for in-flight authorization.
- **Braintree-only**. This table is for our custom-checkout flow. Shopify Payments orders DON'T write transactions rows — they only write [[orders]] + their `payment_details` JSONB.
- **`attempted_at` is required**, `settled_at` + `refunded_at` track lifecycle. Always write `attempted_at` first.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
