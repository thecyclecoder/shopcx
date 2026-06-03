# products

Synced from Shopify Online Store channel. `variants` JSONB is legacy — real source is `product_variants`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `shopify_product_id` | `text` | — |  |
| `title` | `text` | — |  |
| `handle` | `text` | ✓ |  |
| `product_type` | `text` | ✓ |  |
| `vendor` | `text` | ✓ |  |
| `status` | `text` | ✓ |  |
| `tags` | `text[]` | ✓ | default: `'{}'` |
| `image_url` | `text` | ✓ |  |
| `variants` | `jsonb` | ✓ | default: `'[]'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `description` | `text` | ✓ |  |
| `inventory_updated_at` | `timestamptz` | ✓ |  |
| `rating` | `numeric` | ✓ |  |
| `rating_count` | `int4` | ✓ |  |
| `target_customer` | `text` | ✓ |  |
| `certifications` | `text[]` | ✓ | default: `'{}'` |
| `intelligence_status` | `text` | ✓ | default: `'none'` |
| `allergen_free` | `text[]` | ✓ | default: `'{}'` |
| `awards` | `text[]` | ✓ | default: `'{}'` |
| `is_bestseller` | `bool` | — | default: `false` |
| `featured_widget_article_ids` | `uuid[]` | — | default: `'{}'` |
| `header_text` | `text` | ✓ |  |
| `header_text_color` | `text` | ✓ |  |
| `header_text_weight` | `text` | ✓ |  |
| `amazon_price_cents` | `int4` | ✓ |  |
| `upsell_product_id` | `uuid` | ✓ | → [[products]].id |
| `upsell_complementarity` | `jsonb` | ✓ |  |
| `bundle_name` | `text` | ✓ |  |
| `avalara_tax_code` | `text` | ✓ |  |
| `shopify_category` | `text` | ✓ |  |
| `shopify_category_id` | `text` | ✓ |  |
| `taxable` | `bool` | ✓ | default: `true` |

## Foreign keys

**Out (this → others):**

- `upsell_product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[amazon_asins]].`product_id`
- [[demographics_snapshots]].`product_id`
- [[knowledge_base]].`product_id`
- [[macros]].`product_id`
- [[meta_post_cache]].`matched_product_id`
- [[product_benefit_angles]].`product_id`
- [[product_benefit_selections]].`product_id`
- [[product_how_it_works]].`product_id`
- [[product_ingredient_research]].`product_id`
- [[product_ingredients]].`product_id`
- [[product_link_members]].`product_id`
- [[product_media]].`product_id`
- [[product_page_content]].`product_id`
- [[product_pricing_rule]].`product_id`
- [[product_pricing_tiers]].`product_id`
- [[product_review_analysis]].`product_id`
- [[product_reviews]].`product_id`
- [[product_seo_keywords]].`product_id`
- [[product_variants]].`product_id`
- [[products]].`upsell_product_id`
- [[social_comments]].`matched_product_id`
- [[storefront_events]].`product_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("products")
  .select("id, title, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("products")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

### Count since a given time
```ts
const { count } = await admin.from("products")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- `variants` JSONB is a **legacy mirror** — source of truth is `product_variants`. Each JSONB element gets `internal_id` stamped on it so legacy readers can resolve the UUID.
- Internal joins on variants should reference `product_variants.id` (UUID).
- "Default Title" variant is a Shopify placeholder for no-variant products. Never display it — show just the product title. See feedback_default_title_variant.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
