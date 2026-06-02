# product_page_content

PDP content blocks per product (sections, ordering).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `version` | `int4` | — | default: `1` |
| `hero_headline` | `text` | ✓ |  |
| `hero_subheadline` | `text` | ✓ |  |
| `benefit_bar` | `jsonb` | ✓ | default: `'[]'` |
| `mechanism_copy` | `text` | ✓ |  |
| `ingredient_cards` | `jsonb` | ✓ | default: `'[]'` |
| `comparison_table_rows` | `jsonb` | ✓ | default: `'[]'` |
| `faq_items` | `jsonb` | ✓ | default: `'[]'` |
| `guarantee_copy` | `text` | ✓ |  |
| `fda_disclaimer` | `text` | — |  |
| `knowledge_base_article` | `text` | ✓ |  |
| `kb_what_it_doesnt_do` | `text` | ✓ |  |
| `support_macros` | `jsonb` | ✓ | default: `'[]'` |
| `raw_ai_response` | `jsonb` | ✓ |  |
| `status` | `text` | — | default: `'draft'` |
| `generated_at` | `timestamptz` | — | default: `now()` |
| `approved_at` | `timestamptz` | ✓ |  |
| `approved_by` | `uuid` | ✓ |  |
| `published_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `seo_title` | `text` | ✓ |  |
| `seo_description` | `text` | ✓ |  |
| `seo_keywords` | `text[]` | ✓ | default: `'{}'` |
| `expectation_timeline` | `jsonb` | — | default: `'[]'` |
| `endorsements` | `jsonb` | — | default: `'[]'` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_page_content")
  .select("id, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("product_page_content")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("product_page_content")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
