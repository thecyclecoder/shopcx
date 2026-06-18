# Blog → Posts + Product Resources ✅ (MVP shipped 2026-06-10) · Storefront blog ✅ (2026-06-10)

**Owner:** [[../functions/cmo]] · **Parent:** Cmo mandate "Organic content & SEO"

> **Shipped:** all 36 Superfood Scoop articles imported → `posts` (35 resources, 1 blog-only), images migrated off Shopify (0 Shopify-hosted remaining), AI-classified (is_resource + product(s) + grouping), auto-published. Portal Resources UI live (search + product→grouping + reader). Import ran as a 36-agent workflow in ~78s. **Public storefront blog now live** (see § Storefront rendering). Remaining = RAG embedding + periodic re-sync (Future).

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

## Storefront rendering ✅ (2026-06-10)

The public blog lives on the storefront, SSG'd + edge-served exactly like the PDP (no `headers()`/`cookies()`), with the **workspace-logo header + blog nav** instead of the product wordmark. Two URL shapes per page, same as PDPs:

- Public: `{custom-domain}/blog` and `/blog/{handle}` (e.g. `shop.superfoodscompany.com/blog`).
- Preview: `shopcx.ai/store/{ws}/blog[/handle]` — `x-robots-tag: noindex` via middleware so it never competes with the canonical.

**Routes** (under `src/app/(storefront)/store/[workspace]/`):
- `blog/page.tsx` — index. Renders **every** published post into the initial HTML (crawler + LLM friendly); header topic tabs filter client-side via `?topic=` (read from `window.location`, no `useSearchParams` → page stays static). Branded hero band ("The Superfood Scoop") + 3-col card grid.
- `blog/[handle]/page.tsx` — article. Breadcrumb → grouping pill → `<h1>` → `<time>` → featured image → `content_html` in a Tailwind `prose` container → "Shop" CTA → related-posts strip (same grouping first). `content_html` images already point at our storage, so it renders directly.
- Static segment `blog` sits beside the dynamic `[slug]` PDP route; Next gives the static segment precedence (a product handle of "blog" would be shadowed — fine).

**Shared building blocks** (`src/app/(storefront)/`):
- `_lib/blog-data.ts` — `getBlogWorkspaceBySlug`, `listBlogPosts`, `getBlogPost`, `listRelatedPosts`, `listBlogWorkspaceParams`/`listBlogPostParams` (generateStaticParams + sitemap), `BLOG_GROUPINGS` (grouping→label nav vocab). Admin client (storefront is anonymous; `posts` RLS is service-role/authenticated only).
- `_lib/storefront-theme.ts` — `storefrontThemeStyle()` + `SYSTEM_BODY_STACK`, the per-workspace CSS-var theming the PDP applies inline (headings = workspace font, body = system stack).
- `_components/BlogHeader.tsx` — fixed header, transparent→white on scroll (mirrors PDP `StorefrontHeader`). Workspace **logo → `/blog`**, topic tabs (only groupings with posts), **"Shop" button → main brand site** (`superfoodscompany.com`), mobile dropdown.
- `_components/BlogIndexGrid.tsx`, `BlogPostCard.tsx`, `BlogJsonLd.tsx`. Footer reuses `StorefrontFooter`.

**Dashboard view:** `src/app/dashboard/storefront/blog/page.tsx` (sidebar **Storefront › Blog**) — read-only server-component table of every post (thumb, grouping, product-link count, published state, date) with "View" → the preview article URL, plus a "View live blog" link. Lists off the active workspace via `getActiveWorkspaceId()` + admin client.

**SEO + LLM:**
- `generateMetadata` per page: title/description from `seo_title`/`seo_description`/`excerpt`, **canonical → custom domain**, OG `article` (publishedTime/modifiedTime/tags/image), Twitter card, workspace favicon, keywords from `tags`.
- JSON-LD: index emits `Blog` + `blogPost[]`; post emits `BlogPosting` (headline, image, dates, author/publisher Organization+logo, `articleBody` from `content_text`) + `BreadcrumbList`.
- Semantic markup: `<article>`, `<time datetime>`, `<nav>` breadcrumb, real `<h1>`/headings via `prose`.
- `src/app/sitemap.ts` now emits the blog index + every post alongside products.
- Middleware (`src/lib/supabase/middleware.ts`): custom-domain `/blog/{handle}` (2-seg) rewrites to `/store/{ws}/blog/{handle}`; `/blog` rides the existing single-seg rewrite; preview noindex widened from `=== 3` to `>= 3` segments to cover post URLs.

## Future (out of scope now)
- Embed `content_text` into [[../tables/kb_chunks]] so the AI agent can cite a study/recipe in a ticket reply (reuse the `kb/document.updated` pipeline).
- Periodic re-sync (cron) to pick up new/edited Shopify articles.
- Per-post author/byline (no author column on `posts` yet — JSON-LD uses the workspace Organization).

## Completion criteria
- ✅ `posts` + `post_products` tables; all 36 articles imported as posts, images on our storage (**0 Shopify-hosted remaining**), HTML rewritten.
- ✅ Each post classified: is_resource (35 yes / 1 blog-only) + product_ids (43 links, multi-product) + grouping (recipes 22 · how_it_works 7 · how_to_use 5 · science 1), auto-published.
- ✅ Portal Resources: search + product→grouping navigation + post detail renders.
- ✅ Public storefront blog: `/blog` index + `/blog/{handle}` articles, PDP-style chrome with workspace-logo header + topic nav + Shop CTA, SSG + custom-domain rewrite, full SEO/LLM metadata + JSON-LD + sitemap.

## Related
[[../lifecycles/customer-portal]] · [[../integrations/shopify]] · [[../tables/products]] · [[../tables/knowledge_base]] · [[README]]
