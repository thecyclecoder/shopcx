# product_variants

First-class variant rows (UUID PK). Source of truth for variants; `products.variants` JSONB is a legacy mirror.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `shopify_variant_id` | `text` | ✓ |  |
| `sku` | `text` | ✓ |  |
| `title` | `text` | ✓ |  |
| `option1` | `text` | ✓ |  |
| `option2` | `text` | ✓ |  |
| `option3` | `text` | ✓ |  |
| `price_cents` | `int4` | — | default: `0` |
| `compare_at_price_cents` | `int4` | ✓ |  |
| `image_url` | `text` | ✓ |  |
| `weight` | `numeric` | ✓ |  |
| `weight_unit` | `text` | ✓ |  |
| `position` | `int4` | — | default: `0` |
| `inventory_quantity` | `int4` | ✓ |  |
| `available` | `bool` | — | default: `true` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `servings` | `int4` | ✓ |  |
| `servings_unit` | `text` | ✓ |  |
| `supplement_facts` | `jsonb` | ✓ |  |
| `taxable` | `bool` | ✓ | default: `true` |
| `shopify_tax_code` | `text` | ✓ |  |
| `isolated_image_url` | `text` | ✓ | ad tool · cut-out product shot; feeds Higgsfield Soul as `reference_image_urls[]` |
| `isolated_image_uploaded_at` | `timestamptz` | ✓ | ad tool |
| `isolated_image_uploaded_by` | `uuid` | ✓ | ad tool |
| `physical_dimensions` | `jsonb` | ✓ | ad tool · per-variant override of [[products]].`physical_dimensions` |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_campaigns]].`variant_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_variants")
  .select("id, title, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_variants")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- UUID PK is canonical. Use it for internal joins.
- `shopify_variant_id` is nullable (allows internal-only variants for future).
- Read via `src/lib/product-variants.ts` helpers (`getProductVariants`, `findVariant`).

## Ad tool

- `isolated_image_url` is the cut-out (background-removed) product shot the ad tool feeds to **Higgsfield Soul** as `reference_image_urls[]` for image generation.
- `physical_dimensions` here **overrides** [[products]].`physical_dimensions` for this variant when present.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
