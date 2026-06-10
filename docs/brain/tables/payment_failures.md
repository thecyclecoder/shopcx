# payment_failures

Per-attempt log within a dunning cycle — card tried, result, attempt type (initial/card_rotation/payday_retry/new_card_retry).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `shopify_contract_id` | `text` | — |  |
| `billing_attempt_id` | `text` | ✓ |  |
| `payment_method_last4` | `text` | ✓ |  |
| `payment_method_id` | `text` | ✓ |  |
| `error_code` | `text` | ✓ |  |
| `error_message` | `text` | ✓ |  |
| `attempt_number` | `int4` | — | default: `1` |
| `attempt_type` | `text` | — |  |
| `succeeded` | `bool` | — | default: `false` · legacy boolean, kept for back-compat |
| `result` | `text` | — | default: `'failed'` · **lifecycle status: `pending` \| `failed` \| `succeeded`**. See gotcha. |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## `result` — the real status (added 2026-06-10)

A `succeeded` boolean couldn't express "attempt submitted, outcome pending." The legacy Appstle dunning logs a row the **moment a billing attempt is submitted** (`dunning.ts` card-rotation) with `succeeded=false`; the real outcome arrives later via the `billing-failure`/`billing-success` webhook. So a pending attempt was indistinguishable from a decline — 262 historical rows were inflating failure counts in analytics, the AI's `get_dunning_status`, and the portal.

`result` separates the three states:
- `pending` — attempt submitted to Appstle, awaiting the webhook result. **Not a decline.**
- `failed` — actually declined.
- `succeeded` — charged.

The webhook now **resolves** the pending row by `billing_attempt_id` (`resolvePendingAttempt` in [[../libraries/dunning]]) → `failed`/`succeeded` instead of inserting a duplicate. **Always filter `result = 'failed'` to count real declines** — never `succeeded = false` (which still includes pending). Internal-dunning failures log `result='failed'` directly (no pending stage).

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
const { data } = await admin.from("payment_failures")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("payment_failures")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Most recent failure for a subscription (UUID join)
```ts
const { data } = await admin.from("payment_failures")
  .select("attempt_number, attempt_type, error_code, payment_method_last4, created_at")
  .eq("subscription_id", subscriptionId)
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
```

### Shopify boundary lookup (webhook ingest only — never for internal joins)
```ts
const { data } = await admin.from("payment_failures")
  .select("*").eq("shopify_contract_id", shopifyId).maybeSingle();
```

### Count since a given time
```ts
const { count } = await admin.from("payment_failures")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `attempt_type`: `initial` / `card_rotation` / `payday_retry` / `new_card_retry` (**lowercase**).
- Per-attempt — distinct from `dunning_cycles` which is per-billing-cycle aggregate.
- **Internal joins use the UUID.** Join to [[subscriptions]] via `subscription_id` UUID — NOT `shopify_contract_id`. Shopify is being sunset; the contract id will be deprecated.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
