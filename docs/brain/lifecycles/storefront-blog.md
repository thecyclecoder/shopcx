# Storefront blog + product resources

End-to-end trace of how Shopify "Superfood Scoop" articles become our own `posts` object, get AI-classified into product resources, render as a public SEO blog **and** surface inside the customer portal. Owned by [[../functions/cmo]] under the "Organic content & SEO" mandate. This is the permanent home for what shipped as the `blog-resources` spec (verified 2026-06-18); the AI-generated-post engine ([[../specs/auto-blog-generation]]) writes into the same `posts` object + render path.

## 1 — Import + classify (one-time / re-runnable)

`src/lib/posts/import-article.ts` ([[../libraries/posts-import-article]]) does the per-article work, idempotent on `(workspace_id, shopify_article_id)`:

1. **Pull** — `fetchBlogArticles(workspaceId)` reads the Shopify Admin GraphQL `articles(first: 100)` (needs the `read_content` scope — `shopcx-97`). SEO title/description come from the `global.title_tag` / `description_tag` **metafields** (no top-level `seo` field on `Article`). See [[../integrations/shopify]].
2. **Classify** — `classifyArticle` calls Sonnet (`claude-sonnet-4-6`) with the title + stripped text + the workspace product catalog (handle + title, shipping/mystery items filtered out). Returns `{ is_resource, product_ids[], grouping, confidence }`. Articles are **untagged**, so the model infers the product(s) from topic. `is_resource` is only true when ≥1 product matched; grouping is from a **fixed vocabulary** (`recipes · how_it_works · how_to_use · science · general`). Any failure (no key, bad JSON, API error) falls back to blog-only.
3. **Migrate images** — `migratePostImages` ([[../libraries/posts-migrate-images]]) downloads every Shopify-CDN `<img>` in the body + the featured image, uploads to the `product-media` bucket at `workspaces/{ws}/posts/{handle}/{sha1}.{ext}`, and rewrites the HTML so **no Shopify-hosted image survives**. Deterministic object names → re-runs overwrite, never duplicate.
4. **Upsert** — writes `posts` (onConflict `workspace_id,shopify_article_id`), then **replaces** the `post_products` join rows.

Initial backfill ran as a **36-agent Workflow** (one agent per article, ≤16 concurrent, ~78s) — idempotent, so a parallel Node script is an equivalent fallback. Result: 36 articles → [[../tables/posts]] (35 resources, 1 blog-only), **0 Shopify-hosted images remaining**, 43 [[../tables/post_products]] links, groupings recipes 22 · how_it_works 7 · how_to_use 5 · science 1, all auto-published (no review gate).

## 2 — Public storefront blog

Rendered from `posts` exactly like the PDP — SSG'd + edge-served, no `headers()`/`cookies()` — with a workspace-logo header + blog nav instead of the product wordmark. Two URL shapes per page:

- **Public:** `{custom-domain}/blog` and `/blog/{handle}` (e.g. `shop.superfoodscompany.com/blog`).
- **Preview:** `shopcx.ai/store/{ws}/blog[/handle]` — `x-robots-tag: noindex` so it never competes with the canonical.

Routes under `src/app/(storefront)/store/[workspace]/`:
- `blog/page.tsx` — index. Renders **every** published post into the initial HTML (crawler/LLM friendly); header topic tabs filter client-side via `?topic=` read from `window.location` (no `useSearchParams` → stays static). Branded hero band + 3-col card grid.
- `blog/[handle]/page.tsx` — article. Breadcrumb → grouping pill → `<h1>` → `<time>` → featured image → `content_html` in a Tailwind `prose` container → "Shop" CTA → related-posts strip (same grouping first). The static `blog` segment sits beside the dynamic `[slug]` PDP route; Next gives the static segment precedence.

Shared building blocks (`src/app/(storefront)/`):
- `_lib/blog-data.ts` — the data loader: `getBlogWorkspaceBySlug`, `listBlogPosts`, `getBlogPost`, `listRelatedPosts`, `listBlogTopics`, `listBlogWorkspaceParams` / `listBlogPostParams` (generateStaticParams + sitemap), and `BLOG_GROUPINGS` (grouping→label nav vocab) / `groupingLabel`. Uses the **admin client** — the storefront is anonymous and `posts` RLS is service-role/authenticated-only.
- `_lib/storefront-theme.ts` — per-workspace CSS-var theming the PDP shares (headings = workspace font, body = system stack).
- `_components/` — `BlogHeader.tsx` (fixed header, transparent→white on scroll; logo → `/blog`, topic tabs, "Shop" → main brand site), `BlogIndexGrid.tsx`, `BlogPostCard.tsx`, `BlogJsonLd.tsx`. Footer reuses `StorefrontFooter`.

**SEO + LLM:** per-page `generateMetadata` (canonical → custom domain, OG `article`, Twitter card, favicon, keywords from `tags`); JSON-LD (`Blog` + `blogPost[]` on the index, `BlogPosting` + `BreadcrumbList` on a post); semantic `<article>`/`<time>`/`<nav>`; `src/app/sitemap.ts` emits the index + every post. Middleware (`src/lib/supabase/middleware.ts`): custom-domain `/blog/{handle}` (2-seg) rewrites to `/store/{ws}/blog/{handle}`, `/blog` rides the single-seg rewrite, and preview-noindex was widened from `=== 3` to `>= 3` segments to cover post URLs.

## 3 — Portal Resources section

`src/app/portal/[slug]/_sections/ResourcesSection.tsx` (a `/resources` sidebar nav item) surfaces resource posts **inside** the customer portal — distinct from Help Center (KB articles) and Support (tickets). See [[customer-portal]]. It hits `/api/portal?route=resources`, handled by `src/lib/portal/handlers/resources.ts`:
- **Default ("owned")** — resolves the customer's owned products from their active/paused subscriptions' items (variant_id → [[../tables/product_variants]] → product_id) across linked accounts ([[../tables/customer_links]]), then returns posts joined via `post_products`, grouped **product → grouping**. Only `is_resource` + `published` posts.
- **Search (`?q=`)** — `title`/`content_text` ilike across **all** published resources (discovery, including products not yet owned).
- **`resourcePost?id=`** — returns one post's `content_html` for the in-portal reader (rendered in a `prose` wrapper; images already on our storage).

Mini-site + in-portal render identically — only chrome differs.

## 4 — Dashboard surface

`src/app/dashboard/storefront/blog/page.tsx` (sidebar **Storefront › Blog**) — read-only server-component table of every post (thumb, grouping, product-link count, published state, date) with "View" → the preview article URL + a "View live blog" link. Lists off the active workspace via `getActiveWorkspaceId()` + admin client. See [[../dashboard/storefront__blog]].

## Files touched

- `src/lib/posts/import-article.ts`, `src/lib/posts/migrate-images.ts`
- `src/app/(storefront)/_lib/blog-data.ts`, `_lib/storefront-theme.ts`
- `src/app/(storefront)/store/[workspace]/blog/page.tsx`, `blog/[handle]/page.tsx`
- `src/app/(storefront)/_components/BlogHeader.tsx`, `BlogIndexGrid.tsx`, `BlogPostCard.tsx`, `BlogJsonLd.tsx`
- `src/app/portal/[slug]/_sections/ResourcesSection.tsx`, `src/lib/portal/handlers/resources.ts`
- `src/app/dashboard/storefront/blog/page.tsx`
- `src/app/sitemap.ts`, `src/lib/supabase/middleware.ts`
- `supabase/migrations/20260610160000_posts.sql`

## Status / open work

**Shipped:** all 36 Superfood Scoop articles imported → [[../tables/posts]] (0 Shopify-hosted images remaining), AI-classified + auto-published; the public `/blog` index + `/blog/{handle}` articles render SSG with full SEO/JSON-LD/sitemap + custom-domain rewrite; the portal Resources section (owned-product nav + cross-resource search + reader) and the Storefront › Blog dashboard are live. Verified in production 2026-06-18.

**Known gaps / not yet shipped:**
- RAG embedding — `content_text` is not yet embedded into [[../tables/kb_chunks]], so the AI agent can't cite a study/recipe in a ticket reply. Would reuse the `kb/document.updated` pipeline.
- Periodic re-sync — no cron picks up new/edited Shopify articles; re-import is manual (idempotent).
- Per-post author/byline — `posts.author_slug` exists (added by [[../specs/auto-blog-generation]]) but imported posts leave it null; JSON-LD uses the workspace Organization.

**Recent activity:**
- `20260610160000_posts.sql` — `posts` + `post_products` tables.

**Open questions:** None.

## Related

[[customer-portal]] · [[storefront-checkout]] · [[../tables/posts]] · [[../tables/post_products]] · [[../integrations/shopify]] · [[../functions/cmo]] · [[README]]
