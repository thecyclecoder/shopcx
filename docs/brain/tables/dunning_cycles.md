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

### Lookup by internal subscription UUID
```ts
const { data } = await admin.from("dunning_cycles")
  .select("*").eq("subscription_id", subscriptionId).maybeSingle();
```

### Shopify boundary lookup (webhook ingest only — never for internal joins)
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

- Status: production values (as of probe): `retrying`, `recovered`, `exhausted`, `skipped`, `active` (**lowercase**). Most rows are `retrying` (in-flight) or `recovered` (success). `active` is rare and short-lived. No `paused` state on this row — pausing the SUB is a `payment_failures` event + `subscriptions.status='paused'`.
- Per-(subscription, billing cycle). Don't conflate with `payment_failures` which is per-attempt within a cycle.
- Driven by Inngest `dunning/payment-failed`. See Phase 5 in CLAUDE.md.
- **Internal joins use the UUID.** Join to [[subscriptions]] via `subscription_id` UUID — NOT `shopify_contract_id`. Shopify is being sunset; the contract id will be deprecated. `subscription_id` is column-nullable but always populated in practice for cycles created by our Inngest path; a NULL is a data issue worth surfacing, not a fallback signal.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
