# product_seo_keywords

Per-product SEO keyword targets for ad/landing-page copy.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `keyword` | `text` | — |  |
| `monthly_searches` | `int4` | ✓ |  |
| `competition` | `text` | ✓ |  |
| `competition_index` | `numeric` | ✓ |  |
| `cpc_low_cents` | `int4` | ✓ |  |
| `cpc_high_cents` | `int4` | ✓ |  |
| `relevance` | `text` | ✓ |  |
| `is_selected` | `bool` | ✓ | default: `false` |
| `source` | `text` | ✓ | default: `'keyword_planner'` |
| `search_console_clicks` | `int4` | ✓ |  |
| `search_console_impressions` | `int4` | ✓ |  |
| `search_console_ctr` | `numeric` | ✓ |  |
| `search_console_position` | `numeric` | ✓ |  |
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
const { data } = await admin.from("product_seo_keywords")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_seo_keywords")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
