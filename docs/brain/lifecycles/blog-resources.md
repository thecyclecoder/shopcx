# Blog → Posts + Product Resources

The end-to-end flow that turns the 36 Shopify "Superfood Scoop" articles into a self-hosted, AI-classified [[../tables/posts]] object rendered in two surfaces: the **public storefront blog** (SEO/LLM-optimized) and the in-house portal **Resources** section. Replaces a Shopify-locked, untagged blog with content we own — images on our storage, product + grouping classification, searchable. The sibling [[auto-blog-generation]] lifecycle *generates* net-new `posts` daily into these same surfaces (this page is import + render; that one is generation).

## Why

The blog held guides, clinical studies, and recipes that are ideal portal Resources and organic-search assets, but they lived on Shopify (untagged, Shopify-hosted images). Adding the `read_content` scope (`shopcx-97`) let the Admin API pull them; AI fills in the structure Shopify never had.

## Phase 1 — Import + classify

`importBlogArticle(workspaceId, article)` ([[../libraries/posts__import-article]]), idempotent on `shopify_article_id`:

1. **Pull** via the Shopify Admin API ([[../integrations/shopify]], `read_content`): title, handle, body, image, seo, publishedAt, tags, blog.handle, summary.
2. **Classify** (`classifyArticle` — Sonnet): given title + text + the product catalog, return `{ is_resource, product_ids[], grouping, confidence }`. Posts are **untagged**, so product membership is inferred from topic. Blog-only → `is_resource:false`.
3. **Migrate images** (`migratePostImages`): every Shopify-CDN `<img>` + the featured image → Supabase `product-media` storage → rewrite the HTML. **No Shopify-hosted image survives.**
4. **Upsert** [[../tables/posts]] + replace [[../tables/post_products]] rows.

**Groupings = fixed vocab:** `recipes` · `how_it_works` · `how_to_use` · `science` · `general`. **Auto-publish** (no review gate — edit mistakes after the fact). **Multiple products per post** via the [[../tables/post_products]] join.

## Phase 2 — Run the import (Workflow)

The per-article work is independent → fan out instead of 1-by-1. A **Workflow** runs one agent per article (≤16 concurrent, `pipeline(articles, importStage)`); each runs `importBlogArticle` (the classification AI lives inside). Idempotent, so reruns are safe. Initial backfill: **36 articles in ~78s** → 35 resources + 1 blog-only, 43 product links, groupings recipes 22 · how_it_works 7 · how_to_use 5 · science 1, **0 Shopify-hosted images remaining**.

## Phase 3 — Portal Resources UI

`ResourcesSection` in the in-house portal ([[customer-portal]]): a **search bar** (title + content_text + product, `is_resource` + `published`), **product → grouping** two-level navigation, and a post detail that renders `content_html` (our hosted images). A post in multiple products appears under each. Distinct from **Help Center** (KB articles) and **Support** (tickets).

## Phase 4 — Public storefront blog

The public blog is SSG'd + edge-served exactly like the PDP (no `headers()`/`cookies()`), with the workspace-logo header + blog nav instead of the product wordmark. Two URL shapes per page (same as PDPs):

- Public: `{custom-domain}/blog` and `/blog/{handle}`.
- Preview: `shopcx.ai/store/{ws}/blog[/handle]` — `x-robots-tag: noindex` via middleware.

**Routes** (`src/app/(storefront)/store/[workspace]/`):
- `blog/page.tsx` — index. Renders **every** published post into the initial HTML (crawler + LLM friendly); header topic tabs filter client-side via `?topic=` (read from `window.location`, no `useSearchParams` → stays static). Branded hero band + 3-col card grid. Mounts [[../libraries/storefront-pixel]]'s `BlogPixelInit` to instrument.
- `blog/[handle]/page.tsx` — article. Breadcrumb → grouping pill → `<h1>` → `<time>` → featured image → `content_html` in a `prose` container → "Shop" CTA → related-posts strip (same grouping first). Mounts `BlogPixelInit` to instrument.
- The static `blog` segment sits beside the dynamic `[slug]` PDP route; Next gives the static segment precedence.

**Instrumentation** — `BlogPixelInit` (non-PDP): fires `blog_view` on mount (logs blog session to `storefront_sessions` + `storefront_events`) + fires `blog_engaged` once on first of scroll-50% / 30s-dwell (see [[../tables/storefront_events]] for event types). Meta base PageView fires automatically when `metaPixelId` is configured, enabling retargeting. Blog sessions land with `landing_url /blog/…` (no product_handle), appearing in funnel-tree as unattributed non-product traffic.

**Shared building blocks** (`src/app/(storefront)/`): `_lib/blog-data.ts` (data + `BLOG_GROUPINGS` + generateStaticParams/sitemap helpers, admin client) · `_lib/storefront-theme.ts` (per-workspace CSS-var theming) · `_components/BlogHeader.tsx` (logo → `/blog`, topic tabs, "Shop" → main brand site) · `BlogIndexGrid.tsx` · `BlogPostCard.tsx` · `BlogJsonLd.tsx`. Footer reuses `StorefrontFooter`.

**SEO + LLM:** per-page `generateMetadata` (canonical → custom domain, OG `article`, Twitter card, favicon, keywords from tags); JSON-LD (`Blog` + `blogPost[]` on the index, `BlogPosting` + `BreadcrumbList` on the article); semantic markup (`<article>`, `<time datetime>`, breadcrumb `<nav>`); `src/app/sitemap.ts` emits the index + every post; middleware (`src/lib/supabase/middleware.ts`) rewrites custom-domain `/blog/{handle}` → `/store/{ws}/blog/{handle}` and widens the preview-noindex rule to `>= 3` segments.

## Admin view

`src/app/dashboard/storefront/blog/page.tsx` (sidebar **Storefront › Blog**) — read-only table of every post (thumb, grouping, product-link count, published, date) with "View" → preview URL + "View live blog". See [[../dashboard/storefront__blog]].

## Files touched

| File | Purpose |
|---|---|
| `src/lib/posts/import-article.ts` | Pull + classify + upsert ([[../libraries/posts__import-article]]) |
| `src/lib/posts/migrate-images.ts` | Image migration off Shopify |
| `src/app/(storefront)/_lib/blog-data.ts` | Storefront blog data + nav vocab |
| `src/app/(storefront)/store/[workspace]/blog/page.tsx` | Public index |
| `src/app/(storefront)/store/[workspace]/blog/[handle]/page.tsx` | Public article |
| `src/app/(storefront)/_components/Blog*.tsx` | Header, grid, card, JSON-LD |
| `src/app/dashboard/storefront/blog/page.tsx` | Admin table |
| `src/app/sitemap.ts` | Blog index + posts in sitemap |
| `src/lib/supabase/middleware.ts` | Custom-domain rewrite + preview noindex |
| portal `_sections/ResourcesSection.tsx` | In-portal Resources UI |

## Status / open work

**Shipped:** All 36 Superfood-Scoop articles imported → [[../tables/posts]] (35 resources, 1 blog-only), images migrated off Shopify (0 Shopify-hosted remaining), AI-classified (is_resource + product(s) + grouping), auto-published. Portal Resources UI live (search + product→grouping + reader). Public storefront blog live (`/blog` index + `/blog/{handle}`, PDP-style chrome, SSG + custom-domain rewrite, full SEO/LLM metadata + JSON-LD + sitemap). Verified + archived 2026-06-18.

**Known gaps / not yet shipped:**
- RAG embedding — embed `content_text` into [[../tables/kb_chunks]] so the AI agent can cite a study/recipe in a ticket reply (reuse the `kb/document.updated` pipeline).
- Periodic re-sync (cron) to pick up new/edited Shopify articles.
- ✅ Per-post author/byline — shipped via `posts.author_slug` + the [[../libraries/blog__authors]] registry for **AI-generated** posts ([[auto-blog-generation]]); imported Shopify posts still render the workspace Organization (no author in the Shopify payload).

**Recent activity:**
- `94c9fadf` storefront-survey-chapter (#71) — adjacent storefront work
- Blog import ran as a 36-agent Workflow (2026-06-10)

**Open questions:** None.

## Related

[[customer-portal]] · [[storefront-checkout]] · [[auto-blog-generation]] · [[../tables/posts]] · [[../tables/post_products]] · [[../libraries/posts__import-article]] · [[../integrations/shopify]] · [[../dashboard/storefront__blog]] · [[../tables/products]] · [[../tables/kb_chunks]]
