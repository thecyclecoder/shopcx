# products

Synced from Shopify Online Store channel. `variants` JSONB is legacy — real source is `product_variants`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `shopify_product_id` | `text` | — |  |
| `meta_id` | `text` | ✓ | Meta catalog product-group id. Copied from `shopify_product_id`. Variant-level catalog matching uses [[product_variants]].meta_id; this is the group fallback. See [[meta-capi]]. |
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
| `physical_dimensions` | `jsonb` | ✓ | ad tool · `{length_in, width_in, height_in, weight_oz?, shape: bag\|box\|bottle\|jar\|pouch\|other}` |
| `is_advertised` | `bool` | — | default: `false` · true for the 6 hero SKUs the workspace actively advertises (Superfood Tabs / Amazing Coffee / Amazing Creamer / Ashwavana Guru Focus / Ashwavana Zen Relax / Creatine Prime+). Every ad/DR/creative pipeline reads it via [[../libraries/advertised-products]] (`isAdvertisedProduct` / `listAdvertisedProductIds`) so attachment SKUs (Tumbler, Sleep Gummies, Handheld Drink Mixer, Bamboo Coffee Mug) never enter advertising. Seeded by `supabase/migrations/20261015000000_products_is_advertised.sql`. |

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
- [[ad_avatar_proposals]].`product_id`
- [[ad_campaigns]].`product_id`
- [[product_ad_angles]].`product_id`
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

## Ad tool

- `physical_dimensions` (jsonb) drives package/B-roll framing in the ad tool. `product_variants` may carry a per-variant override.
- `target_customer`, `certifications`, `allergen_free`, and `awards` are the **canonical Tier-5 structured proof source** for [[product_ad_angles]] (proof points like "USDA Organic", "no soy", awards). Tiers 1-4 of ad-angle sourcing live in [[product_page_content]] (Tier-1), [[product_benefit_selections]] (Tier-2), [[product_ingredient_research]] (Tier-3), and [[product_reviews]] (Tier-4).
- `is_advertised` is the **hero-product advertising gate**. Only rows with `is_advertised=true` may enter the ad/DR/creative pipeline (Carrie DR-content, Dahlia ad-creative, product angle-gen, media-buyer fan-out). Reads go through [[../libraries/advertised-products]]; direct `.eq("is_advertised", true)` at call sites is discouraged so the flag stays a single-owner gate. Attachment SKUs (Tumbler, Sleep Gummies, Handheld Drink Mixer, Bamboo Coffee Mug) stay false and are structurally excluded.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
