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
| `pack_size` | `int2` | ✓ | 1\|2 — units a single order line represents (null until resolved) |
| `units_per_pack` | `int4` | ✓ | servings/pods in the pack (optional, best-effort from title) |
| `pack_resolved_by` | `text` | ✓ | `price`\|`order_price`\|`title`\|`manual` — pack provenance |

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

## Pack resolution

`pack_size` is resolved by [[../libraries/amazon__sync-orders]] `resolveAsinPack` using **per-product
price bands** (a product's 1-pack base = lowest positive `current_price_cents` among its ASINs;
~2× base = 2-pack), falling back to a real order-line price (`order_price`) when the catalog price is
$0, then title servings (`title`). `pack_resolved_by = 'manual'` is never overwritten by the resolver.
Validated coffee seed (2026-06-21): 1-pack `B08KYMN52M·B0BV4WHWCX·B0BKR169VT·B0BLR2B936·B0FGHBP2QY` ·
2-pack `B08C47SJ5B·B0BV4XY3L7·B0BLQRD681`.

## Gotchas

- **One Active ASIN was still unmapped at seed time: `B0DK7RJZQY`** (`product_id` null — not in the
  coffee group). Its Amazon revenue lands under `product_id = null` in
  [[daily_amazon_product_snapshots]] until a product is assigned.
- Probe before assuming — see [[../README]] § Probing technique.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
