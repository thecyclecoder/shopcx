# dunning_cycles

Per-(subscription, billing cycle) dunning state machine. status: active/skipped/paused/recovered/exhausted. See Phase 5 in CLAUDE.md.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `shopify_contract_id` | `text` | — |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `cycle_number` | `int4` | — | default: `1` |
| `status` | `text` | — |  |
| `cards_tried` | `text[]` | ✓ | default: `'{}'` |
| `payment_update_sent` | `bool` | ✓ | default: `false` |
| `payment_update_sent_at` | `timestamptz` | ✓ |  |
| `skipped_at` | `timestamptz` | ✓ |  |
| `recovered_at` | `timestamptz` | ✓ |  |
| `paused_at` | `timestamptz` | ✓ |  |
| `billing_attempt_id` | `text` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `updated_at` | `timestamptz` | ✓ | default: `now()` |
| `original_billing_date` | `timestamptz` | ✓ |  |
| `next_retry_at` | `timestamptz` | ✓ |  |
| `terminal_error_code` | `text` | ✓ |  |
| `terminal_cards` | `text[]` | ✓ | default: `'{}'` |
| `last_attempted_last4` | `text` | ✓ |  |

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
const { data } = await admin.from("dunning_cycles")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("dunning_cycles")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("dunning_cycles")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Cross-Shopify boundary lookup
```ts
const { data } = await admin.from("dunning_cycles")
  .select("*").eq("shopify_contract_id", shopifyId).maybeSingle();
```

### Count since a given time
```ts
const { count } = await admin.from("dunning_cycles")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Status: `active` / `skipped` / `paused` / `recovered` / `exhausted`.
- Per-(subscription, billing cycle). Don't conflate with `payment_failures` which is per-attempt within a cycle.
- Driven by Inngest `dunning/payment-failed`. See Phase 5 in CLAUDE.md.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
