# cart_drafts

Server-side cart state for the custom storefront. Token-bound, server-validated pricing, lifecycle: pending → converted/abandoned. See STOREFRONT.md.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `token` | `text` | — |  |
| `anonymous_id` | `text` | ✓ |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `line_items` | `jsonb` | — | default: `'[]'` |
| `discount_code` | `text` | ✓ |  |
| `subscription_frequency_days` | `int4` | ✓ |  |
| `shipping_address` | `jsonb` | ✓ |  |
| `billing_address` | `jsonb` | ✓ |  |
| `email` | `text` | ✓ |  |
| `phone` | `text` | ✓ |  |
| `subtotal_cents` | `int4` | — | default: `0` |
| `discount_cents` | `int4` | — | default: `0` |
| `shipping_cents` | `int4` | — | default: `0` |
| `tax_cents` | `int4` | — | default: `0` |
| `total_cents` | `int4` | — | default: `0` |
| `status` | `text` | — | default: `'open'` |
| `converted_order_id` | `uuid` | ✓ | → [[orders]].id |
| `expires_at` | `timestamptz` | — | default: `(now() + '30 days'::interval)` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `source_product_handle` | `text` | ✓ |  |
| `abandoned_email_sent_at` | `timestamptz` | ✓ |  |
| `avalara_quote_tax_cents` | `int4` | ✓ |  |
| `avalara_quote_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `converted_order_id` → [[orders]].`id`
- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("cart_drafts")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("cart_drafts")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("cart_drafts")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("cart_drafts")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Token-bound (cart cookie). Server **always** re-validates line totals against `pricing_rules`; never trust client.
- Lifecycle: `pending` → `converted` (linked to `converted_order_id`) or `abandoned` (cron flips after `expires_at`).
- Abandoned drafts retained for analytics — don't delete.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
