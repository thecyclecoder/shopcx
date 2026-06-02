# loyalty_settings

Per-workspace loyalty program config — tiers, point earn rates, redemption tiers.

**Primary key:** `workspace_id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `enabled` | `bool` | — | default: `false` |
| `points_per_dollar` | `int4` | — | default: `10` |
| `points_per_dollar_value` | `int4` | — | default: `100` |
| `redemption_tiers` | `jsonb` | — |  |
| `coupon_applies_to` | `text` | — | default: `'both'` |
| `coupon_combines_product` | `bool` | — | default: `true` |
| `coupon_combines_shipping` | `bool` | — | default: `true` |
| `coupon_combines_order` | `bool` | — | default: `false` |
| `coupon_expiry_days` | `int4` | — | default: `90` |
| `exclude_tax` | `bool` | — | default: `true` |
| `exclude_discounts` | `bool` | — | default: `true` |
| `exclude_shipping` | `bool` | — | default: `true` |
| `exclude_shipping_protection` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | ✓ | default: `now()` |
| `updated_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("loyalty_settings")
  .select("created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("loyalty_settings")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
