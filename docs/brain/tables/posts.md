# posts

The canonical blog/resource object — either **imported** from the Shopify "Superfood Scoop" blog ([[../lifecycles/blog-resources]]) or **auto-generated** by the daily blog engine ([[../lifecycles/auto-blog-generation]]) — AI-classified, and rendered in two places: the **public storefront blog** (`/blog`) and the in-house portal **Resources** section.

## Summary

One row per blog article. Self-hosted (images migrated off Shopify onto our `product-media` storage), storefront-renderable (SSG + custom-domain rewrite), and classified at import time: is it a **product resource**, **which product(s)** does it belong to ([[post_products]]), and which **grouping** (recipes / how_it_works / how_to_use / science / general).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK → [[workspaces]] |
| `shopify_article_id` | text | **idempotency key** — UNIQUE per workspace (upsert target). NOT NULL; AI posts use the synthetic **`ai:{handle}`** convention to satisfy it |
| `blog_handle` | text | source blog (`superfood-scoop`) |
| `handle` | text | article slug — the `/blog/{handle}` URL segment |
| `title` | text | |
| `excerpt` | text | short summary (Shopify `summary`) |
| `content_html` | text | body HTML — **image `src` rewritten to OUR storage** (no Shopify-CDN URL survives) |
| `content_text` | text | stripped plain text — search + future embedding |
| `featured_image_url` | text | OUR storage (migrated) |
| `seo_title`, `seo_description` | text | drives `generateMetadata` |
| `tags` | text[] | from Shopify; feed OG/keywords |
| `is_resource` | bool | AI: product resource vs blog-only |
| `grouping` | text | fixed vocab (`recipes` · `how_it_works` · `how_to_use` · `science` · `general`); null when not a resource |
| `published` | bool | + `published_at` (timestamptz) |
| `source` | text | `shopify_blog` (imported) \| `ai_generated` (daily auto-blog engine) |
| `author_slug` | text | byline persona for AI posts ([[../libraries/blog__authors]] registry); null on imports → render the workspace Organization. Migration `20260610200000_blog_author_social.sql` |
| `social_image_url` | text | 4:5 portrait crop (1080×1350) the organic social scheduler posts; never shown on the blog. Falls back to `featured_image_url`. Same migration |
| `created_at`, `updated_at` | timestamptz | |

## Foreign keys

- **out:** `workspace_id` → [[workspaces]]
- **in:** [[post_products]].`post_id` → `posts.id` (a post belongs to many products)

## Gotchas

- **`grouping` is a fixed vocabulary** — `recipes` · `how_it_works` · `how_to_use` · `science` · `general`. The classifier picks one; the portal + storefront nav (`BLOG_GROUPINGS`) maps it to a label. Extensible later, but don't write free-text values.
- **Grouping lives on the post, not the join** — a recipe is a recipe across every product it mentions. The UI nests product → grouping → posts.
- **RLS is service-role/authenticated only** — the storefront is anonymous, so `_lib/blog-data.ts` reads via the admin client.
- **Idempotent import** — upsert on `shopify_article_id`; re-running [[../libraries/posts__import-article]] is safe.
- A product handle of `blog` would be shadowed by the static `/blog` storefront segment — fine (no product is named "blog").

## Common queries

```ts
// published resources for a product, grouped
const { data } = await admin
  .from("post_products")
  .select("posts!inner(id,title,handle,grouping,featured_image_url,published)")
  .eq("product_id", productId)
  .eq("posts.is_resource", true)
  .eq("posts.published", true);
```

## Related

[[post_products]] · [[../lifecycles/blog-resources]] · [[../lifecycles/auto-blog-generation]] · [[../libraries/posts__import-article]] · [[../libraries/blog__authors]] · [[products]] · [[../integrations/shopify]] · [[kb_chunks]]
