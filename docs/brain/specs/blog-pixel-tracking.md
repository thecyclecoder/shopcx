# Add storefront pixel tracking to the blog pages

**Owner:** [[../functions/platform]] (devops executes) · **Parent:** [[growth]] objective — full-funnel + traffic-source visibility for the Growth Director.
**Status:** ⏳ planned — drafted 2026-06-30, routed to devops. Not yet built.

## Problem
The blog (`shop.superfoodscompany.com/blog`, routed at `src/app/(storefront)/store/[workspace]/blog/`) loads **no pixel**. The pixel is mounted per-page on PDP/landers (`_lib/render-page.tsx`) + checkout/customize/thank-you — **not** in the shared `(storefront)/layout.tsx`, so blog routes are a tracking blind spot:
- **No blog sessions/engagement** — we can't see blog traffic, which posts get read, dwell, or blog→product CTR. Blog readers only become visible *after* they click into the store.
- **No Meta pixel on the blog** — `initMetaPixel` only runs inside `initPixel`, so blog readers don't fire Meta `PageView` and aren't added to **retargeting audiences**. Any paid/organic traffic sent to blog posts is invisible to Meta.

**Not affected (already works):** the funnel-tree **"Blog" referrer slice**. Blog and store are same-origin, so a blog→product click carries `document.referrer = …/blog/…`, captured on the *product* page and bucketed by `referrerGroup()` on the `/blog` path. This spec does NOT need to fix referrer attribution.

## Goals
1. Create a storefront session + fire a `blog_view` event when a blog page loads.
2. Capture blog engagement (`blog_engaged` — scroll/dwell, mirroring `pdp_engaged`).
3. Fire the **Meta base pixel `PageView`** on blog pages (retargeting coverage) via the existing `metaPixelId` plumbing.
4. Keep blog traffic OUT of the product funnel's PDP/visit counts (don't fire `pdp_view` on the blog).

## Non-goals
- No new Meta *standard* event for blog (PageView is enough for retargeting; `blog_view` stays internal telemetry, not in `META_EVENT_MAP`).
- No referrer-attribution work (already functioning).

## Current-state facts (verified 2026-06-30)
- `ALLOWED_EVENT_TYPES` is a **Set** in `src/app/api/pixel/route.ts` (~line 38); anything not in it is **silently dropped**. New event types must be added there.
- `storefront_events.event_type` is free `text` (no DB CHECK/enum) → **no migration** needed for the column.
- Product pages pass the pixel `workspaceId` + `metaPixelId` (`data.workspace.meta_pixel_id`) — the blog page already loads `workspace`, so both are available.
- `storefront_events.product_id` is nullable → blog events carry `product_id = null`.

## Design
1. **`BlogPixelInit` client component** (new, under `(storefront)/_components/`) — a trimmed `StorefrontPixelInit`: calls `initPixel({ workspaceId, metaPixelId })`, fires `track("blog_view", { blog_handle, title })` on mount, and a single `blog_engaged` on first scroll-50%/30s-dwell (reuse the engagement-trigger pattern). **No** pack-select/cart/`pdp_view` logic. Mount it in `store/[workspace]/blog/page.tsx` (index) + `blog/[handle]/page.tsx` (post), passing `workspaceId`, `metaPixelId`, and the post handle/title.
2. **Allowlist** — add `"blog_view"` and `"blog_engaged"` to `ALLOWED_EVENT_TYPES` (and the "Defined event types" list in `docs/brain/lifecycles/storefront-checkout.md`).
3. **Meta** — passing `metaPixelId` to `initPixel` fires the base `PageView` automatically (`initMetaPixel`). No `META_EVENT_MAP` change.

## Open decision (please confirm before building)
**How should blog sessions appear in the funnel-tree?** A blog session lands with `landing_url = …/blog/…` → no product handle → today it would fall into the **"Unattributed entry (non-product landing)"** row. Options:
- **(a)** Leave as unattributed (simplest; blog is just "non-product traffic"). 
- **(b)** Add a first-class **"Blog"** top-level node in `funnel-tree.ts` (resolve `/blog` landings to a synthetic "Blog" bucket) so blog→nothing vs blog→product is legible.
Recommend **(b)** if blog volume grows; **(a)** is fine to start. Either way, blog `blog_view` must NOT increment product `visit`/`pdp_view`.

## Verification
- Load a blog post → a `storefront_sessions` row is created with `landing_url` `/blog/…` and a `blog_view` event lands (not dropped by the allowlist).
- Scroll/dwell → one `blog_engaged`.
- Meta Events Manager shows `PageView` from blog URLs; a blog reader enters retargeting audiences.
- The funnel-tree "Blog" **referrer** slice still populates from blog→product clickthroughs (unchanged).
- `npx tsc --noEmit` clean.

## Brain pages to update on ship
[[../lifecycles/storefront-checkout]] (defined event types), [[../tables/storefront_events]] (blog_view/blog_engaged), [[../libraries/storefront-pixel]] (BlogPixelInit), and — if option (b) — [[../libraries/funnel-tree]].

## Related
Sibling of [[pixel-pdp-view-delivery]] (pixel reliability) and [[../libraries/funnel-tree]] (the referrer slice that already captures blog→store).
