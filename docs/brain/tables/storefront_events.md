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
| `event_type` | `text` | — | See **Event types** below for the canonical list |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `meta` | `jsonb` | — | default: `'{}'` |
| `url` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Event types

The canonical list (kept in sync with `src/app/api/pixel/route.ts` ALLOWED_EVENT_TYPES):

**Product funnel:** `pdp_view` (product page load) → `pdp_engaged` (scroll/interact) → `pack_selected` → `add_to_cart` → `checkout_view` → `order_placed`

**Chapter/content funnel:** `chapter_view` → `chapter_dwell` → `scroll_depth` → `cta_click`

**Blog:** `blog_view` (mounted on blog index/article) → `blog_engaged` (first of scroll-50% / 30s-dwell)

**Other:** `lead_captured` · `experiment_exposure`

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
