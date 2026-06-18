# posts/import-article

`src/lib/posts/import-article.ts` — imports + AI-classifies a Shopify blog article into our [[../tables/posts]] object. Idempotent on `(workspace_id, shopify_article_id)`. The backbone of [[../lifecycles/storefront-blog]].

## Exports

| Symbol | Signature | What |
|---|---|---|
| `fetchBlogArticles` | `(workspaceId) → Promise<RawArticle[]>` | Pulls all articles via the Shopify Admin GraphQL `articles(first: 100, reverse: true)`. SEO fields come from the `global.title_tag` / `description_tag` **metafields** (no top-level `seo` on `Article`). Needs the `read_content` scope. |
| `classifyArticle` | `(workspaceId, {title, contentText}, catalog?) → Promise<Classification>` | Sonnet (`claude-sonnet-4-6`) decides `{ is_resource, product_ids[], grouping, confidence }` given the article + product catalog. Infers product(s) from topic (articles are untagged). |
| `importBlogArticle` | `(workspaceId, article: RawArticle, catalog?) → Promise<ImportResult>` | Full per-article: classify → `migratePostImages` → upsert `posts` → **replace** `post_products`. |
| `cleanBodyHtml` / `cleanExcerpt` / `htmlToText` | helpers | Strip Shopify editor cruft (meta/base/comments), build a ≤240-char excerpt, HTML→text for search/classification. |
| `GROUPINGS` / `Grouping` | `["recipes","how_it_works","how_to_use","science","general"]` | The fixed grouping vocabulary the classifier picks from. |

## Behavior notes

- **Classification fails safe** — no `ANTHROPIC_API_KEY`, a non-OK response, unparseable JSON, or a thrown error all return blog-only (`is_resource:false`, no products, no grouping). `is_resource` is forced false unless ≥1 product matched; grouping defaults to `general` when a resource has no valid grouping.
- **Catalog filtering** — `loadProductCatalog` excludes shipping/mystery items by handle + title before handing the list to the model.
- **Idempotent** — upsert on the `workspace_id,shopify_article_id` unique key; `post_products` rows are deleted + re-inserted each run.

## Callers

- The import Workflow / backfill (one agent per article).
- [[../specs/auto-blog-generation]] mirrors the write path (`upsert posts` + replace `post_products`) for AI-generated posts.

## Gotchas

- Images are migrated by [[posts-migrate-images]] **before** the upsert, so `content_html` written to the row is already rewritten — never persist the raw Shopify body.
- The classifier prompt asks for product **handles**; `importBlogArticle` maps them back to UUIDs and silently drops unknown handles.

## Related

[[posts-migrate-images]] · [[../tables/posts]] · [[../tables/post_products]] · [[../integrations/shopify]] · [[../lifecycles/storefront-blog]]
