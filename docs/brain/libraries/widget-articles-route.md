# libraries/widget-articles-route

Public storefront endpoint that returns the contextual KB articles rendered by the chat widget. Called by every storefront page that mounts the widget island (product pages, cart, generic paths), unauthenticated.

**File:** `src/app/api/widget/[workspaceId]/articles/route.ts`
**Route:** `GET /api/widget/[workspaceId]/articles`

## Query params

- `pid` — internal product UUID OR the legacy `shopify_product_id`. UUID is auto-normalized to `shopify_product_id` via the `products` table.
- `handle` — product handle fallback when `pid` is absent.
- `search` — free-text term; matches `knowledge_base.title` OR `knowledge_base.content` via `ilike`.
- `path` — storefront path; resolved against `widget_path_mappings` for category context.

## Response

```json
{ "articles": KnowledgeBaseArticle[], "help_slug"?: string }
```

Selection precedence:
1. `search` present → title/content ILIKE, boosted so product-tagged results sort first if `pid`/`handle` was supplied.
2. `pid`/`handle` present → merchant's `featured_widget_article_ids` (order preserved) + other product-tagged `knowledge_base` rows, up to 5.
3. `path` present → articles in the category resolved from `widget_path_mappings`.
4. Fill remaining slots with the most-viewed articles for the workspace.

## Bounded timeout — reliability contract

Because this endpoint is on the shopper's critical rendering path (the widget island blocks on it) it MUST fail fast rather than ride Vercel's default 300s lambda ceiling:

- **`export const maxDuration = 15`** at module scope — Vercel hard-caps the whole handler at 15s.
- **`.abortSignal(AbortSignal.timeout(8000))`** attached to every `admin.from(...)` chain — any single Supabase call aborts after 8s.
- **`try { … } catch { return NextResponse.json({ articles: [] }); }`** wrapping the handler body — any thrown error (including the AbortError from a timed-out query) degrades to an empty article list with `200`. The widget already tolerates an empty payload, so an empty response is preferred over a 5xx or a hung Lambda.

The bleed this closes: an ILIKE substring scan over `knowledge_base.content` (a plain `text` column with no trigram / GIN index) can grow slow on a workspace with a large KB; without a deadline one such call rode the full 300s ceiling and returned a hard-failure to the shopper's browser. Deeper index work on `knowledge_base.content` (FTS / `pg_trgm`) is a separate performance follow-up — bounding the route stops the reliability bleed first.

## Tables read

- `workspaces` — verify the workspace + read `help_slug`.
- `products` — normalize `pid` (UUID → shopify id), resolve product by handle, read `featured_widget_article_ids`.
- `widget_path_mappings` — map `path` to a category.
- `knowledge_base` — the article corpus.

## Gotchas

- Empty payload does NOT indicate failure — a bounded-timeout abort and a legitimate "no matches" both return `{ articles: [] }`. Server logs are the authoritative signal.
- The route is unauthenticated by design (storefront island) — no session, no CORS gate beyond the app-level middleware.

---

[[../README]] · [[../../CLAUDE]]
