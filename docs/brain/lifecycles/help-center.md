# Help Center lifecycle

The public-facing knowledge-base site. One per workspace, served at a brand subdomain (`help.{brand-domain}` or `{brand-slug}.shopcx.ai`). Articles are written + edited in the dashboard, scraped from existing help sites for migration, served with SEO + search + feedback widgets, and integrated into the AI agent via RAG.

## Surfaces

| Surface | Where | Purpose |
|---|---|---|
| **Dashboard editor** | `/dashboard/knowledge-base` | Admin writes / edits / publishes articles |
| **Public help site** | `help.{brand}.com` or `{slug}.shopcx.ai` (workspace `help_slug` + optional `help_custom_domain`) | Customers search + read articles, vote helpful, submit a ticket from the article |
| **AI agent RAG** | Sonnet via `get_product_knowledge` tool | Articles get chunked + embedded; the orchestrator retrieves relevant chunks when answering product / policy questions |

Subdomain routing for the public site goes through `src/lib/supabase/middleware.ts` (now `src/proxy.ts` per Next.js 16 naming) — the proxy detects the hostname and rewrites to the help-center routes. Custom domains are auto-added to the Vercel project via the `VERCEL_API_TOKEN` integration; customers add a CNAME and the brain wires the rest.

## Article model

- [[../tables/knowledge_base]] — one row per article. Fields: `slug`, `title`, `content_html`, `published` (toggle), `view_count`, `helpful_yes` / `helpful_no` (vote tallies), product mapping (which Shopify products this article relates to).
- [[../tables/kb_chunks]] — pgvector embeddings (1536-dim, OpenAI `text-embedding-3-small`) for RAG retrieval. Created via the `kb-embed-document` Inngest function whenever an article publishes / updates.

URLs:
- Main site: `https://shopcx.ai/help/{slug}/{article-slug}` (multi-brand routing).
- Brand subdomain: `https://{slug}.shopcx.ai/{article-slug}` — clean URLs, no `/help/` prefix.
- Custom domain: `https://help.{brand}.com/{article-slug}` — same.

## Content sourcing

Two paths:

1. **Author from scratch** in the dashboard editor — rich-text contentEditable + toolbar, slug auto-generated from title, draft/publish toggle, product associations.
2. **Scrape from existing help site** — Inngest function `scrape-help-center` (`src/lib/inngest/scrape-help-center.ts`) crawls a target URL (tested at help.superfoodscompany.com — 200+ articles), strips Gorgias widget markup, decodes HTML entities, maps article topics to Shopify products via partial keyword matching.

## Article view → AI agent

When the orchestrator gets a product / policy question, it calls `get_product_knowledge`. That tool:

1. Queries the macros table for direct text matches.
2. Queries [[../tables/kb_chunks]] via pgvector similarity (top-K with threshold).
3. Returns merged result to Sonnet.

Articles published in the dashboard automatically become available to the AI on next request — no manual sync step. The embedding job (`kb-embed-document` Inngest fn) fires on `knowledge_base/upsert` events.

## Public site features

- **Categories** — articles tagged by category, rendered as filter chips on the search page.
- **Search** — client-side filter for v1; pgvector semantic search planned.
- **Most Viewed** — sorted by `view_count`, capped at top 10 per category.
- **Most Helpful** — sorted by helpful_yes / (helpful_yes + helpful_no) ratio, min N votes.
- **Article view tracking** — increments `view_count` on `GET /help/{article}`.
- **Helpful vote** — thumbs up/down at the bottom of every article → increments tally + writes to per-customer vote log (de-duped by IP for anon, customer_id for logged-in).
- **Public ticket creation form** — at the bottom of every article + on a dedicated `/help/contact` page. Channel `help_center` on the resulting ticket. Goes through the unified ticket handler same as inbound email.
- **SEO** — JSON-LD structured data per article; sitemap.xml auto-generated; OG image per workspace.

## Branding

- Logo + primary color stored on `workspaces.help_logo_url` / `workspaces.help_primary_color`. Customer-facing pages pick these up automatically.
- Falls back to ShopCX.ai defaults if not configured.

## Status / open work

**Shipped:** Dashboard editor (rich-text, slug, publish, product mapping). Public help site (categories, search, voting, article tracking, ticket-form). Subdomain + custom-domain routing. KB scraper for migrations (Gorgias-stripped + product-mapped). RAG integration via `kb-embed-document` Inngest fn. SEO + OG images. Per-workspace branding.

**Known gaps / not yet shipped:**
- **pgvector public search** — public site uses client-side string filter. Semantic search via [[../tables/kb_chunks]] is planned, not wired.
- **Multi-language** — articles are single-language per row. No i18n model for translations.

**Recent activity:**
- `12f954ff` docs/brain: lifecycles/ — 12 narrative pages tracing key flows end-to-end

**Open questions:**
- When does public-side pgvector search ship? Currently the AI has it but customers don't.

## Files touched

| File | Purpose |
|---|---|
| `src/app/dashboard/knowledge-base/page.tsx` | Article list (dashboard) |
| `src/app/dashboard/knowledge-base/[id]/page.tsx` | Article editor (dashboard) |
| `src/app/help/[slug]/page.tsx` | Public help-site landing (multi-brand routing) |
| `src/app/help/[slug]/[article]/page.tsx` | Public article view |
| `src/app/[article]/page.tsx` | Brand-subdomain clean-URL article view |
| `src/lib/inngest/scrape-help-center.ts` | Migration scraper |
| `src/lib/inngest/kb-embed-document.ts` | RAG embedding job |
| `src/lib/rag.ts` | Retrieval helper used by `get_product_knowledge` |
| `src/lib/embeddings.ts` | Multi-provider embedding wrapper |
| `src/proxy.ts` | Subdomain + custom-domain routing |

## Related

[[ai-multi-turn]] · [[ticket-lifecycle]] · [[../tables/knowledge_base]] · [[../tables/kb_chunks]] · [[../integrations/openai]] · [[../inngest/kb-embed-document]] · [[../inngest/scrape-help-center]] · [[../dashboard/knowledge-base]] · [[../orchestrator-tools]]
