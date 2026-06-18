# libraries/posts/import-article

The Shopify-blog → [[../tables/posts]] import + AI-classification pipeline. Idempotent per article; ran as a 36-agent Workflow for the initial backfill. See [[../lifecycles/blog-resources]].

**Files:** `src/lib/posts/import-article.ts` (pull + classify + upsert) · `src/lib/posts/migrate-images.ts` (image migration)

## Exports — `import-article.ts`

| Export | Purpose |
|---|---|
| `GROUPINGS` / `Grouping` | The fixed grouping vocab: `recipes` · `how_it_works` · `how_to_use` · `science` · `general`. |
| `fetchBlogArticles(workspaceId)` | Pull every Superfood-Scoop article via the Shopify Admin API ([[../integrations/shopify]] `getShopifyCredentials`, `read_content` scope): `title, handle, body, image, seo{title,description}, publishedAt, tags, blog.handle, summary`. Returns `RawArticle[]`. |
| `classifyArticle(article, products)` | **AI (Sonnet)** — given title + text + the product catalog (id/title/handle/keywords/benefits), returns `Classification { is_resource, product_ids[], grouping, confidence }`. Untagged posts → product membership is *inferred from topic* ("Taylor Swift's Chai Cookies Featuring Amazing Creamer" → Amazing Creamer / `recipes`). Blog-only → `is_resource:false`, no products. |
| `importBlogArticle(workspaceId, article)` | The per-article pipeline: classify → `migratePostImages` → **upsert** [[../tables/posts]] on `shopify_article_id` → **replace** [[../tables/post_products]] rows. Idempotent. Returns `ImportResult`. |
| `cleanBodyHtml` / `cleanExcerpt` / `htmlToText` | HTML hygiene helpers (strip wrappers, derive `content_text`, build excerpt). |

## Exports — `migrate-images.ts`

| Export | Purpose |
|---|---|
| `migratePostImages(...)` | Download every Shopify-CDN `<img>` in the body + the featured image → upload to Supabase storage (`product-media` bucket, `workspaces/{ws}/posts/{handle}/{file}`) → rewrite the HTML `src` + `featured_image_url` to our URLs. Returns `MigratedImages`. **No Shopify-hosted image survives.** |

## Callers

- The initial backfill ran as a **Workflow** (one agent per article, ≤16 concurrent, `pipeline(articles, importStage)`) — 36 articles in ~78s. See [[../recipes/migrate-shopify-images]] for the image-migration pattern.
- Re-runnable ad-hoc (idempotent upsert) to pick up new/edited articles.

## Reading side (storefront)

The public blog reads via `src/app/(storefront)/_lib/blog-data.ts` (admin client — `posts` RLS is service-role/authenticated only): `getBlogWorkspaceBySlug`, `listBlogPosts`, `getBlogPost`, `listRelatedPosts`, `listBlogTopics`, `listBlogWorkspaceParams`/`listBlogPostParams` (generateStaticParams + sitemap), `BLOG_GROUPINGS` (grouping→label nav vocab).

## Gotchas

- **Idempotency key is `shopify_article_id`** — never the handle (handles can change).
- **`classifyArticle` returns product UUIDs**, not Shopify ids — internal joins use UUIDs.
- The classifier picks **one** grouping from the fixed set; storing free text breaks the nav.

## Related

[[../tables/posts]] · [[../tables/post_products]] · [[../lifecycles/blog-resources]] · [[../integrations/shopify]] · [[../tables/products]] · [[../recipes/migrate-shopify-images]] · [[../integrations/anthropic]]
