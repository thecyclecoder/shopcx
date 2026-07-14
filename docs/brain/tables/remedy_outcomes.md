# remedy_outcomes

Per-(session, remedy, reason) tracking — shown / accepted / rejected. Drives AI remedy selection learning.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `subscription_id` | `uuid` | ✓ | → [[subscriptions]].id |
| `cancel_reason` | `text` | — |  |
| `remedy_id` | `uuid` | ✓ | → [[remedies]].id |
| `remedy_type` | `text` | — |  |
| `offered_text` | `text` | ✓ |  |
| `accepted` | `bool` | — |  |
| `outcome` | `text` | ✓ | CHECK: `NULL \| 'accepted' \| 'passed_over' \| 'rejected'` (per `remedy_outcomes_outcome_check`, see `supabase/migrations/20260401200000_remedy_tracking_overhaul.sql`). No other literals — an insert of e.g. `'cancelled'` / `'saved'` is rejected with Postgres 23514 and drops silently unless the caller checks the error. |
| `customer_ltv_cents` | `int4` | ✓ |  |
| `subscription_age_days` | `int4` | ✓ |  |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `first_renewal` | `bool` | ✓ | default: `false` |
| `shown` | `bool` | — | default: `true` |
| `session_id` | `uuid` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `remedy_id` → [[remedies]].`id`
- `subscription_id` → [[subscriptions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("remedy_outcomes")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("remedy_outcomes")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("remedy_outcomes")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Drives AI remedy-selection learning. Per-reason stats kick in at 200+ data points; otherwise global stats.
- `first_renewal` boolean flags 'never renewed yet' so first-renewal save rate stays separate from steady-state.
- `outcome` vocabulary is a CHECK constraint (`NULL | 'accepted' | 'passed_over' | 'rejected'`). The cancel-flow completion route writes `'rejected'` when a customer declined every remedy and churned, and `'accepted'` when a remedy was taken. Do NOT write `'cancelled'` / `'saved'` (those are the JOURNEY-level outcome on `journey_sessions.outcome`, a different column on a different table). Always error-check `remedy_outcomes` inserts — the constraint rejects an unknown literal with 23514, which is silent unless the caller reads the error.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
