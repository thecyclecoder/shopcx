# customer_payment_methods

Customer payment methods snapshot from Shopify (last4, brand, expiry). Used for dunning card rotation dedup.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `braintree_customer_id` | `text` | — |  |
| `braintree_payment_method_token` | `text` | — |  |
| `payment_type` | `text` | — | default: `'credit_card'` |
| `card_brand` | `text` | ✓ |  |
| `last4` | `text` | ✓ |  |
| `expiration_month` | `text` | ✓ |  |
| `expiration_year` | `text` | ✓ |  |
| `is_default` | `bool` | — | default: `false` |
| `status` | `text` | — | default: `'active'` |
| `created_from_cart_token` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `provider` | `text` | — | default: `'braintree'` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[transactions]].`payment_method_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("customer_payment_methods")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("customer_payment_methods")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("customer_payment_methods")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("customer_payment_methods")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
