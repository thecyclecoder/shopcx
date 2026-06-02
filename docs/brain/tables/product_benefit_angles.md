# product_benefit_angles

Benefit angles per product (anti-aging, energy, gut health) for marketing/PDP copy generation.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `benefit_key` | `text` | — |  |
| `hero_headline` | `text` | ✓ |  |
| `hero_subheadline` | `text` | ✓ |  |
| `featured_ingredient_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `lead_review_keywords` | `text[]` | ✓ | default: `'{}'` |
| `comparison_row_order` | `int4[]` | ✓ | default: `'{}'` |
| `faq_priority_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `is_active` | `bool` | ✓ | default: `true` |
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
const { data } = await admin.from("product_benefit_angles")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_benefit_angles")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
