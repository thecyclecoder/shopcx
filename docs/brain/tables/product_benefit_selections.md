# product_benefit_selections

Per-(product, angle) selection of which benefit angle is in active rotation.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `benefit_name` | `text` | — |  |
| `role` | `text` | — |  |
| `display_order` | `int4` | — | default: `0` |
| `science_confirmed` | `bool` | — | default: `false` |
| `customer_confirmed` | `bool` | — | default: `false` |
| `customer_phrases` | `text[]` | ✓ | default: `'{}'` |
| `customer_review_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `ingredient_research_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `ai_confidence` | `numeric` | ✓ |  |
| `notes` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_benefit_selections")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_benefit_selections")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

## Ad tool

- **Tier-2 ad-angle source** for [[product_ad_angles]]. Qualifying rows: `role='lead' AND science_confirmed=true` → contribute `benefit_name` + `customer_phrases[]` + `ingredient_research_ids[]`.
- `benefit_name` is one of the two allowed verbatim sources for [[product_ad_angles]].`lead_benefit_anchor` (the other is [[product_page_content]].`benefit_bar[].text`).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
