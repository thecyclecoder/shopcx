# amazon_asins

Amazon catalog — ASIN ↔ product mapping, pricing, rank. Source for reseller discovery and pricing intelligence.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `amazon_connection_id` | `uuid` | — | → [[amazon_connections]].id |
| `asin` | `text` | — |  |
| `sku` | `text` | ✓ |  |
| `title` | `text` | ✓ |  |
| `image_url` | `text` | ✓ |  |
| `status` | `text` | — | default: `'Active'` |
| `product_id` | `uuid` | ✓ | → [[products]].id |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `current_price_cents` | `int4` | ✓ |  |
| `list_price_cents` | `int4` | ✓ |  |
| `sale_price_cents` | `int4` | ✓ |  |
| `price_fetched_at` | `timestamptz` | ✓ |  |

## Foreign keys

**Out (this → others):**

- `amazon_connection_id` → [[amazon_connections]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("amazon_asins")
  .select("id, title, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("amazon_asins")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("amazon_asins")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
