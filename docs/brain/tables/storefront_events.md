# storefront_events

Append-only storefront event log (pdp_view, pack_selected, order_placed, etc.). PK is client-generated UUID for CAPI dedup. 90d retention.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `session_id` | `uuid` | — | → [[storefront_sessions]].id |
| `anonymous_id` | `text` | — |  |
| `customer_id` | `uuid` | ✓ | → [[customers]].id |
| `event_type` | `text` | — |  |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `meta` | `jsonb` | — | default: `'{}'` |
| `url` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `customer_id` → [[customers]].`id`
- `product_id` → [[products]].`id`
- `session_id` → [[storefront_sessions]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[event_dispatches]].`event_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("storefront_events")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a customer (expand linked accounts first)
```ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("storefront_events")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
```

### Count since a given time
```ts
const { count } = await admin.from("storefront_events")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- PK is client-generated UUID — same id forwarded to CAPI sinks for dedup.
- Append-only. **90-day retention** via daily cron.
- Denormalized `anonymous_id` + `customer_id` for fast funnel queries.
- `identity_source` records how we know who this is (cookie, purchase, portal_login, backfilled_*). Filter to high-confidence identities for attribution.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
