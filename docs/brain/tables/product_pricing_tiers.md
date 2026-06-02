# product_pricing_tiers

Per-product pricing tiers (1-pack / 3-pack / 6-pack) with price.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `variant_id` | `text` | — |  |
| `tier_name` | `text` | — |  |
| `quantity` | `int4` | — | default: `1` |
| `price_cents` | `int4` | — |  |
| `subscribe_price_cents` | `int4` | ✓ |  |
| `subscribe_discount_pct` | `int4` | ✓ | default: `25` |
| `per_unit_cents` | `int4` | ✓ |  |
| `badge` | `text` | ✓ |  |
| `is_highlighted` | `bool` | ✓ | default: `false` |
| `display_order` | `int4` | — | default: `0` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_pricing_tiers")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_pricing_tiers")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
