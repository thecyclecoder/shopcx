# product_review_analysis

Aggregate review analysis (sentiment, key phrases, themes).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `top_benefits` | `jsonb` | — | default: `'[]'` |
| `before_after_pain_points` | `jsonb` | ✓ | default: `'[]'` |
| `skeptic_conversions` | `jsonb` | ✓ | default: `'[]'` |
| `surprise_benefits` | `jsonb` | ✓ | default: `'[]'` |
| `most_powerful_phrases` | `jsonb` | ✓ | default: `'[]'` |
| `reviews_analyzed_count` | `int4` | — | default: `0` |
| `raw_ai_response` | `jsonb` | ✓ |  |
| `analyzed_at` | `timestamptz` | — | default: `now()` |
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
const { data } = await admin.from("product_review_analysis")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_review_analysis")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
