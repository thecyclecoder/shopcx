# replacements

Reshipment/replacement orders. Created by playbooks or agent action. Counts against customer's replacement_threshold.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `original_order_id` | `uuid` | ✓ | → [[orders]].id |
| `original_order_number` | `text` | ✓ |  |
| `replacement_order_id` | `uuid` | ✓ | → [[orders]].id |
| `shopify_draft_order_id` | `text` | ✓ |  |
| `shopify_replacement_order_id` | `text` | ✓ |  |
| `shopify_replacement_order_name` | `text` | ✓ |  |
| `reason` | `text` | — |  |
| `reason_detail` | `text` | ✓ |  |
| `items` | `jsonb` | ✓ |  |
| `status` | `text` | — | default: `'pending'` |
| `customer_error` | `bool` | — | default: `false` |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `address_validated` | `bool` | ✓ | default: `false` |
| `validated_address` | `jsonb` | ✓ |  |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `subscription_adjusted` | `bool` | ✓ | default: `false` |
| `new_next_billing_date` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `original_order_id` → [[orders]].`id`
- `replacement_order_id` → [[orders]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("replacements")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("replacements")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("replacements")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Rows for a ticket
```ts
const { data } = await admin.from("replacements")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("replacements")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- **Replacements ship to the customer's current address, not the original order's snapshot.** When creating a replacement, the system resolves the destination via [[../libraries/customer-shipping-address]] `resolveCustomerShippingAddress()` — it prefers `customers.default_address` (canonical current), then subscription address, then the original order's snapshot as last resort. This prevents stale address snapshots from silently shipping to the wrong location (ticket 49ddd6c4). The resolved address is validated and stored in `validated_address`; an operator can override via `address_override` on the action.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
