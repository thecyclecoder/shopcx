# pricing_rules

Storefront pricing rules — tier qty, mode (subscription vs one-time), frequency, discount %, line-item price.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `is_active` | `bool` | — | default: `true` |
| `quantity_breaks` | `jsonb` | — | default: `'[]'` |
| `free_shipping` | `bool` | — | default: `false` |
| `free_shipping_threshold_cents` | `int4` | ✓ |  |
| `free_gift_variant_id` | `text` | ✓ |  |
| `free_gift_product_title` | `text` | ✓ |  |
| `free_gift_image_url` | `text` | ✓ |  |
| `free_gift_min_quantity` | `int4` | ✓ | default: `1` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `subscribe_discount_pct` | `int4` | — | default: `0` |
| `available_frequencies` | `jsonb` | — | default: `'[]'` |
| `free_shipping_subscription_only` | `bool` | — | default: `false` |
| `free_gift_subscription_only` | `bool` | — | default: `false` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[product_pricing_rule]].`pricing_rule_id`
- [[pricing_rule_offers]].`pricing_rule_id`

## Dynamic persist-to-renewal offers (M6)

The base rule here is **static per product**. A **time-boxed, scoped persist-to-renewal offer** that overrides it at renewal lives in the child table [[pricing_rule_offers]] (status `proposed｜approved｜active｜expired`) — an owner-approved `subscribe_discount_pct` override or a fixed renewal price that the [[../libraries/pricing]] engine layers on top of this rule **only while active**. See [[../specs/storefront-dynamic-renewal-offers]] · [[../libraries/storefront-renewal-offers]].

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("pricing_rules")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("pricing_rules")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
