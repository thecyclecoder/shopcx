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
| `benefit_bar` | `jsonb` | ✓ | default: `'[]'` · array of `{ icon_hint?, text }`; first item leads the hero stack |
| `benefit_bar_intro` | `text` | ✓ | problem/solution lead-in **headline** rendered above the benefit cards (e.g. "Tired of brain fog and a scale that won't budge…"). Null = no lead-in. |
| `benefit_bar_transition` | `text` | ✓ | one-line transition under the intro that hands off to the cards (e.g. "Amazing Coffee was made to change that:") |
| `mechanism_copy` | `text` | ✓ |  |
| `ingredient_cards` | `jsonb` | ✓ | default: `'[]'` |
| `comparison_table_rows` | `jsonb` | ✓ | default: `'[]'` |
| `comparison_competitor_label` | `text` | ✓ | round-3 lander refinement — the rival *category* the comparison chapter compares against (e.g. "Coffee & Energy Drinks", "Plain Creatine"); null → `ComparisonSection` falls back to "Regular Coffee" (the coffee default) |
| `show_survey` | `bool` | — | default: `false` — gates the (hardcoded coffee-specific) `SurveyChapter`; `render-page` only renders it when true. Backfilled `true` for `amazing-coffee` + `amazing-coffee-pods` only |
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

## Ad tool

- **Tier-1 ad-angle source** for [[product_ad_angles]] — the highest-priority, already-approved claim copy. Fields used: `hero_headline`, `hero_subheadline`, `benefit_bar`, `guarantee_copy`, `expectation_timeline`.
- `benefit_bar[].text` is one of the two allowed verbatim sources for [[product_ad_angles]].`lead_benefit_anchor` (the other is [[product_benefit_selections]].`benefit_name`).
- Always pull the **latest published** version: `WHERE status='published' ORDER BY version DESC LIMIT 1`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
