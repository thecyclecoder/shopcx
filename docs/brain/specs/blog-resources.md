# Blog → Posts + Product Resources ⏳

**Goal:** import the 36 Shopify "Superfood Scoop" blog articles into our own `posts` object, migrate their images off Shopify onto our storage, and — during import — use AI to decide which posts are **product resources**, **which product(s)** they belong to (they're untagged, so infer from title + content), and which **grouping** they are (Recipes / How it works / How to use / …). Then surface the relevant ones in the portal **Resources** section with a search bar + product→grouping navigation. Storefront rendering of posts is a later phase.

**Why now:** the blog has tons of guides, clinical studies, and recipes that are perfect portal Resources, but they live on Shopify (untagged, Shopify-hosted images). We just added the `read_content` scope (`shopcx-97`) so the Admin API can pull them.

Decisions settled 2026-06-10:
1. **Groupings = fixed vocabulary** — `recipes` · `how_it_works` · `how_to_use` · `science` · `general`. AI picks from this set (extensible later).
2. **Auto-publish** — AI classification applies live immediately; edit mistakes after the fact (no review gate).
3. **Multiple products per post** — `post_products` join table (a recipe using Creamer + Coffee shows under both).

## Data model (Phase 1)

**`posts`** — the canonical blog/resource object (storefront-renderable later):
```
id, workspace_id
shopify_article_id (text, unique per ws)   -- import idempotency key
blog_handle (text)                          -- 'superfood-scoop'
handle (text)                               -- article handle (slug)
title, excerpt
content_html (text)                         -- image URLs rewritten to OUR storage
content_text (text)                         -- stripped, for search + future embedding
featured_image_url (text)                   -- OUR storage (migrated)
seo_title, seo_description (text)
tags (text[])
is_resource (bool)                          -- AI: product resource vs blog-only
grouping (text)                             -- fixed vocab; null when not a resource
published (bool) + published_at (timestamptz)
source (text, 'shopify_blog'), created_at, updated_at
```
**`post_products`** — join (a post → many products):
```
post_id → posts.id, product_id → products.id, workspace_id
UNIQUE (post_id, product_id)
```
Grouping lives on the POST (a recipe is a recipe across products); the UI nests product → grouping → posts.

## Import + classify pipeline (Phase 1)

`src/lib/posts/import-article.ts` — `importBlogArticle(workspaceId, article)`, idempotent (upsert on `shopify_article_id`):
1. **Pull** via Admin API ([[../integrations/shopify]] `getShopifyCredentials`): `title, handle, body (content_html), image, seo{title,description}, publishedAt, tags, blog.handle, summary` (`read_content`).
2. **Classify** (`classifyArticle` — AI, Sonnet): given title + text content + the product catalog (id/title/handle/keywords), return `{ is_resource, product_ids[], grouping, confidence }`. Blog-only → `is_resource:false`, no products.
3. **Migrate images** (`migratePostImages`): download every Shopify-CDN `<img>` in the body + the featured image → upload to Supabase storage (`product-media` bucket, `workspaces/{ws}/posts/{handle}/{file}`) → rewrite the HTML `src` + `featured_image_url` to our URLs. **No Shopify-hosted image survives.**
4. **Upsert** `posts` + replace `post_products` rows.

The **product catalog for inference**: all `products` (title, handle, description, benefit selections) — the classifier matches an article to products by topic (e.g. "Taylor Swift's Chai Cookies Featuring Amazing Creamer" → Amazing Creamer / `recipes`; "The Science Behind Amazing Coffee" → Amazing Coffee / `science`).

## Running the import — Workflow (Phase 2)

The per-article work (classify + migrate images + write) is independent across 36 articles → fan out instead of 1-by-1. A **Workflow** runs one agent per article (≤16 concurrent): each agent runs `importBlogArticle` for its article (the classification AI call lives inside). `pipeline(articles, importStage)`; idempotent so reruns are safe. (A parallel Node script with `Promise.all` is the simpler fallback if we don't want the agent layer.)

## Portal Resources UI (Phase 3) — in-house portal only

`ResourcesSection`:
- **Search bar** — query posts (title + content_text + product) where `is_resource` + `published`.
- **Navigation** — group by **product** ("Amazing Creamer") → then by **grouping** ("Recipes", "How it works", "How to use"). Two-level accordion / sections.
- **Post detail** — render `content_html` (our hosted images), featured image, title.
- A post in multiple products appears under each.

## Future (out of scope now)
- Storefront rendering of posts (public `/blog/{handle}` on our storefront).
- Embed `content_text` into [[../tables/kb_chunks]] so the AI agent can cite a study/recipe in a ticket reply (reuse the `kb/document.updated` pipeline).
- Periodic re-sync (cron) to pick up new/edited Shopify articles.

## Completion criteria
- ⏳ `posts` + `post_products` tables; all 36 articles imported as posts, images on our storage (zero Shopify-hosted), HTML rewritten.
- ⏳ Each post classified: is_resource + product_ids + grouping (auto-published).
- ⏳ Portal Resources: search + product→grouping navigation + post detail renders.

## Related
[[../lifecycles/customer-portal]] · [[../integrations/shopify]] · [[../tables/products]] · [[../tables/knowledge_base]] · [[README]]
