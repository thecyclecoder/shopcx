# customer_events

Append-only customer event log — portal actions, subscription mutations, journey responses. Source of truth for the customer activity timeline.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `event_type` | `text` | — |  |
| `source` | `text` | — |  |
| `summary` | `text` | ✓ |  |
| `properties` | `jsonb` | ✓ | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### Customer activity timeline
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("customer_events")
  .select("event_type, properties, created_at")
  .in("customer_id", ids)
  .order("created_at", { ascending: false }).limit(100);
```

### When did this subscription cancel?
```ts
const { data } = await admin.from("customer_events")
  .select("created_at, properties")
  .eq("event_type", "subscription.cancelled")
  .contains("properties", { subscription_id: subId })
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
```

## Gotchas

- Field is `event_type` (not `event_name`) and `properties` JSONB (not `event_data`).
- Source of truth for the activity timeline. Subscription cancel/pause timestamps live here, not on the sub row.
- **Cancel dedup (2026-06-03):** the Appstle webhook handler suppresses its own `subscription.cancelled` (source=appstle) insert when a `portal.subscription.cancelled` (source=portal) already exists for the same `shopify_contract_id` in the prior 5 minutes. Both fire on every portal-initiated cancel; we keep only the portal row because it carries cancel reason + journey context. Historical pre-fix data (April-May 2026) has ~272 still-duplicated pairs — query consumers can dedupe at query time by collapsing to `DISTINCT (shopify_contract_id, date_trunc('minute', created_at))` if exact counts matter for that window.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
