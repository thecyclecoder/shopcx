# product_ingredient_research

Research/citations for each ingredient — used by the ingredient deep-dive PDP section.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `ingredient_id` | `uuid` | — | → [[product_ingredients]].id |
| `benefit_headline` | `text` | — |  |
| `mechanism_explanation` | `text` | — |  |
| `clinically_studied_benefits` | `text[]` | ✓ | default: `'{}'` |
| `dosage_comparison` | `text` | ✓ |  |
| `citations` | `jsonb` | ✓ | default: `'[]'` |
| `contraindications` | `text` | ✓ |  |
| `ai_confidence` | `numeric` | — | default: `0.5` |
| `raw_ai_response` | `jsonb` | ✓ |  |
| `researched_at` | `timestamptz` | — | default: `now()` |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `ingredient_id` → [[product_ingredients]].`id`
- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_ingredient_research")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_ingredient_research")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

## Ad tool

- **Tier-3 ad-angle source** for [[product_ad_angles]]. Qualifying rows: `ai_confidence>=0.6` → contribute `benefit_headline` + `clinically_studied_benefits` + `citations` as the science proof anchor (`proof_anchor.type='science'`).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
