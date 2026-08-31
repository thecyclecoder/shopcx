# journey_sessions

Per-customer journey invocation. token (for `/journey/{token}`), responses, status. The customer-facing artifact.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `journey_id` | `uuid` | — | → [[journey_definitions]].id |
| `customer_id` | `uuid` | — | → [[customers]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id |
| `token` | `text` | — |  |
| `token_expires_at` | `timestamptz` | — |  |
| `status` | `text` | — | default: `'pending'` |
| `current_step` | `int4` | — | default: `0` |
| `responses` | `jsonb` | — | default: `'{}'` |
| `config_snapshot` | `jsonb` | — | default: `'{}'` |
| `outcome` | `text` | ✓ |  |
| `outcome_action_taken` | `bool` | — | default: `false` |
| `started_at` | `timestamptz` | ✓ |  |
| `completed_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `product_id` | `uuid` | ✓ | → [[products]].id · Product this session asks about. Set only by the product-review journey; the other twelve journeys leave it null. Nullable because the column is universal (every journey shares this table) but the semantics are journey-specific. Migration `20261215120000_review_collection_foundations.sql`. |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `journey_id` → [[journey_definitions]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `ticket_id` → [[tickets]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[journey_step_events]].`session_id`
- [[review_requests]].`journey_session_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("journey_sessions")
  .select("id, status, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("journey_sessions")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("journey_sessions")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Rows for a ticket
```ts
const { data } = await admin.from("journey_sessions")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("journey_sessions")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `token` is the URL slug for `/journey/{token}`.
- Steps + config are rebuilt **live** from current data on every mini-site click — no `config_snapshot` to go stale.
- Customer-facing state — never edit directly outside the completion endpoint.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
