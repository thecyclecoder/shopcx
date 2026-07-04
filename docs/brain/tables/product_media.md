# product_media

Per-product media (images, videos) with dimensions and roles (hero, gallery, before/after).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id |
| `slot` | `text` | — | image role/position. Known slots: `hero` (the bag hero + extra hero-gallery slides at `display_order` > 0: lifestyle, static-ad), `lifestyle_1`, `timeline_{N}`, `ingredient_{snake_name}`, `endorsement_{n}_avatar` (re-hosted nutritionist headshot), `before`/`after` (legacy single story) and `before_{n}`/`after_{n}` (up to 2 stories, pairs with `product_page_content.before_after_stories`). All harvested/generated images are re-hosted to this bucket — never a Shopify-CDN hotlink |
| `url` | `text` | ✓ |  |
| `storage_path` | `text` | ✓ |  |
| `alt_text` | `text` | ✓ | default: `''` |
| `width` | `int4` | ✓ |  |
| `height` | `int4` | ✓ |  |
| `file_size` | `int4` | ✓ |  |
| `mime_type` | `text` | ✓ |  |
| `uploaded_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `webp_url` | `text` | ✓ |  |
| `avif_url` | `text` | ✓ |  |
| `webp_storage_path` | `text` | ✓ |  |
| `avif_storage_path` | `text` | ✓ |  |
| `avif_1920_url` | `text` | ✓ |  |
| `webp_1920_url` | `text` | ✓ |  |
| `avif_1920_storage_path` | `text` | ✓ |  |
| `webp_1920_storage_path` | `text` | ✓ |  |
| `avif_480_url` | `text` | ✓ |  |
| `webp_480_url` | `text` | ✓ |  |
| `avif_480_storage_path` | `text` | ✓ |  |
| `webp_480_storage_path` | `text` | ✓ |  |
| `avif_750_url` | `text` | ✓ |  |
| `webp_750_url` | `text` | ✓ |  |
| `avif_750_storage_path` | `text` | ✓ |  |
| `webp_750_storage_path` | `text` | ✓ |  |
| `avif_1080_url` | `text` | ✓ |  |
| `webp_1080_url` | `text` | ✓ |  |
| `avif_1080_storage_path` | `text` | ✓ |  |
| `webp_1080_storage_path` | `text` | ✓ |  |
| `avif_1500_url` | `text` | ✓ |  |
| `webp_1500_url` | `text` | ✓ |  |
| `avif_1500_storage_path` | `text` | ✓ |  |
| `webp_1500_storage_path` | `text` | ✓ |  |
| `display_order` | `int4` | — | default: `0` · gallery order within a slot. The hero gallery shares `slot="hero"` across rows: `0` = bag hero, higher orders = lifestyle / Nano-Banana static-ad slides. Storage path gets a `_{order}` suffix when > 0 so multiple images coexist under one slot |
| `category` | `text` | ✓ | Persuasive job of the asset — Carrie's DR read key ("do we already have an X for this product?"). CHECK ∈ `before_after` \| `ugc` \| `testimonial_photo` \| `press_logo` \| `lifestyle` \| `hero` \| `ingredient` \| `mechanism` \| `other`. Populated for Carrie's DR-content pass; historic rows leave it NULL. |
| `source` | `text` | ✓ | Where the asset came from. CHECK ∈ `uploaded` \| `generated` \| `scout` \| `shopify`. Populated for Carrie's DR-content pass; historic rows leave it NULL. |
| `caption` | `text` | ✓ | DR-shaped caption (Carrie's voice), distinct from `alt_text` (SEO-shaped for the storefront). |

## Foreign keys

**Out (this → others):**

- `product_id` → [[products]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("product_media")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("product_media")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Categorized DR store (Phase 1 of [[../specs/carrie-dr-content]])

Carrie's `dr-content` box lane treats `product_media` as permanent, categorized product intelligence — keyed by `product_id` + `category`. That's the whole point of the `category` / `source` / `caption` columns: her decision "generate this or open a gap?" turns on "do we already have a `category='before_after'` row for this product?" (yes → reuse; no + real-evidence → open a [[lander_content_gaps]] row; no + generatable → Nano Banana Pro → row with `source='generated'`).

**Real-evidence categories** (`before_after`, `ugc`, `testimonial_photo`, `press_logo`) are the never-fake-a-customer-result line — Carrie NEVER writes a row here with `source='generated'` for these. Real-evidence + no existing row → open a [[lander_content_gaps]] row for the founder to supply.

**Chokepoint:** the DR write path goes through [[../libraries/lander-blueprints]] `writeCategorizedProductMedia` — no raw `.from('product_media').insert|upsert` with `category` / `source` / `caption` outside the SDK. (Legacy write sites — [[../libraries/product-intelligence]] `seed-tools.saveMedia`, [[../libraries/product-intelligence]] `engine`, etc — write the non-DR columns unchanged.)

## Gotchas

- **`category` and `source` are NULL on historic rows.** Rows written before Phase 1 of [[../specs/carrie-dr-content]] never carried the columns — Carrie's read-by-category ignores those (they're pre-DR content).
- **`category='before_after' | 'ugc' | 'testimonial_photo' | 'press_logo'` must have `source ≠ 'generated'`.** Not enforced by a CHECK constraint yet — it's the SDK discipline in [[../libraries/lander-blueprints]] `writeCategorizedProductMedia` (never called with a real-evidence category from a generation step). Fabricated customer results are the harm; the discipline is upstream.
- **`caption` ≠ `alt_text`.** `alt_text` is SEO/accessibility; `caption` is the DR caption Carrie writes for the founder to review.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
