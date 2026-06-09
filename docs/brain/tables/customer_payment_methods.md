# customer_payment_methods

Customer payment methods snapshot from Shopify (last4, brand, expiry). Used for dunning card rotation dedup.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `braintree_customer_id` | `text` | ✓ | null for `provider='shopify'` rows |
| `braintree_payment_method_token` | `text` | ✓ | null for `provider='shopify'` rows; UNIQUE |
| `shopify_payment_method_id` | `text` | ✓ | Shopify CustomerPaymentMethod gid; set for `provider='shopify'` rows. UNIQUE per workspace (partial index) |
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

- **Two providers live here.** `provider='braintree'` rows (storefront / internal subs) carry a `braintree_payment_method_token` and are charged via Braintree. `provider='shopify'` rows (Appstle subs) carry a `shopify_payment_method_id` instead — the Braintree columns are null. A CHECK constraint requires at least one handle. Braintree charge paths filter by token/provider, so Shopify rows are inert to them — never charge a Shopify row through Braintree (the comment in the provider migration: "Braintree tokens are nonsense to Shopify and vice versa").
- **Shopify rows are written by the payment-method webhook**, via `syncShopifyPaymentMethods()` in `src/lib/dunning.ts` (provider migration originally said only `/api/checkout` writes — that's stale; the webhook is now a second writer). Dunning card-rotation still reads cards **live from Shopify**, not from this table.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
