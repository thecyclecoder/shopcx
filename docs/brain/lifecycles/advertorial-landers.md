# Lifecycle: auto-generated ad-matched landers (advertorial + before/after)

Turns an advertorial / before-after **ad** into a scent-matched **landing page** so the cold-50+ click doesn't bounce on the standard branded PDP. A lander is a **layout mode of the PDP** reached via `?variant=advertorial|beforeafter&angle={slug}`: only the editorial TOP (hero + chapter 1) is generated; everything below it (ingredients, price table, reviews, checkout) is the existing PDP, reused unchanged. Per ad *angle*, reused across all campaigns/ads of that angle. Targets the proven **86%→24% hero cliff** (funnel evidence in the spec).

**Code:** `src/lib/advertorial-pages.ts` (reader + generator) · `src/lib/inngest/ad-tool.ts` (`adToolAdvertorialPageRequested`, auto-trigger on `ready`) · `src/app/(storefront)/_lib/render-page.tsx` (layout branch) · `src/app/(storefront)/_sections/AdvertorialHero.tsx` · `AdvertorialChapter.tsx` · `BeforeAfterHero.tsx` · `WeightLossTestimonialWall.tsx` · `src/app/(storefront)/_components/StickyJumpNav.tsx` · `src/app/api/ads/campaigns/[id]/advertorial/route.ts`. **Table:** [[../tables/advertorial_pages]].

## Flow

1. **Trigger** — when a campaign reaches `ready` ([[ad-render]]), `adToolRenderRequested` fires `ad-tool/advertorial-page-requested`. (Also on demand: `POST /api/ads/campaigns/[id]/advertorial`.)
2. **Generate** — `generateAdvertorialPagesForCampaign(workspaceId, campaignId)`:
   - Loads the campaign's angle (`product_ad_angles`) + the five PI tiers (`loadAngleInputs`, [[../libraries/ad-angles]]) + the campaign's `hero_image_url` + `script_text`.
   - `generateAdvertorialNarrative` — Opus generates the editorial **headline + dek + chapter-1 narrative** (problem → mechanism/story → proof) from the *same* angle + PI + ad script (so the lander is scent-matched by construction), gated through `validateAdScript` ([[../libraries/ad-validator]]) for banned words. Deterministic PI fallback when the API is off → the lander always renders.
   - **Hero auto-pick by angle:** testimonial/transformation/social-proof → the avatar holding-product shot (`ad_campaigns.hero_image_url`, persisted as a re-signable `ad-tool` path); mechanism/curiosity/clinical → an ingredient shot (resolved from `product_media` at render).
   - Always builds the **advertorial** lander; additionally builds the **before/after** lander when the product has real `before`/`after` `product_media`.
   - **Persist** an [[../tables/advertorial_pages]] row per variant, keyed `(workspace_id, product_id, slug)`. `slug = {hook_slug}-{angle_id[:8]}` (readable + unique); the before/after row appends `-ba`.
3. **Render** — the storefront route reads `?variant` + `?angle`; `loadAdvertorialContent(data, variant, slug)` resolves the persisted row (re-signing the hero `ad-tool` path), falling back to PI-derived content. `StorefrontPage` branches on `advertorial`:
   - **advertorial:** `AdvertorialHero` (editorial serif masthead, SPONSORED label) → `StickyJumpNav` → `AdvertorialChapter` (narrative + drop cap) → reuse `IngredientsSection` + `PriceTableSection` + `ReviewsSection` + `FinalCTASection` + `BrandTrustSection`.
   - **beforeafter:** `BeforeAfterHero` (real before/after panels) → `HeroSection` (the PDP hero, **reused as the product intro / chapter 2** — introduce the product right after the transformation hook) → `StickyJumpNav` → `WeightLossTestimonialWall` (5★ reviews filtered to weight/appearance) → reuse ingredients/pricing/final-CTA/trust.
   - Every new section carries `data-section` → auto-instrumented by `StorefrontChapterTracker` (funnel + A/B free). The sticky nav's "See pricing" carries `data-cta-kind="scroll_to_price"` so jump-aware tracking credits the jump.
4. **Ad → lander wiring** — `POST /api/ads/campaigns/[id]/publish` defaults `destination_url` to `advertorialLanderUrl(workspaceId, campaignId)` (the angle's advertorial lander on the custom domain, else `shopcx.ai/store/{slug}/{handle}`). An explicit operator destination still wins.

## Attribution prerequisite (shipped here)
`checkout_view` + `order_placed` now carry `product_id` (the highest-value cart line): client `CheckoutClient.tsx` (both events) + server `api/checkout/route.ts` (canonical `order_placed`, top-level column + meta). `GET /api/workspaces/[id]/storefront-funnel?product_id=…` scopes the whole funnel per product — so advertorial-lander → purchase is measurable per product (previously read 0 below `pack_selected`).

## ISR / routing
The route reads `searchParams` but still no headers/cookies → param-less PDPs stay statically generated (`generateStaticParams`); only `?variant=…` requests render dynamically. Custom domains rewrite via middleware to `/store/{workspace}/{slug}`, preserving the query.

## Copy rules (shared with [[../specs/killer-statics]])
Anchor to the CORE desires — **weight loss · fighting aging · best self · social approval** — never functional energy/no-crash/focus. **Review counts display as actual + 10,000** (`displayReviewCount`). Reuse real `product_media` (endorser photo, before/after, ingredient shots). One `generateAdvertorialNarrative(angle)` feeds the lander (and is the sibling of the advertorial-static copy).

## Decisions / gotchas
- **Per angle, not per campaign** — landers upsert by `(product_id, slug)`, so re-running a campaign of the same angle refreshes rather than duplicates.
- **Hero paths, not signed URLs** — only re-signable `ad-tool` paths are persisted (`hero_storage_path`); expiring signed URLs are dropped so the reader can always re-sign fresh. Ingredient/before-after heroes resolve from `product_media` at render.
- **Reused sections untouched** — the sticky nav scrolls to `[data-section="ingredients"]` / `#pricing` via a client handler, so `IngredientsSection` / `PriceTableSection` need no edits.
- **Auto-design scope = hero + chapter 1 only.** The dead mid-chapters (ugc/comparison/endorsement) are intentionally NOT carried into the lander.

## Status / open work
- ✅ Code-complete (P1–P4) on branch `advertorial-landers`: layout modes + sections, generator + `advertorial_pages` migration + API route, auto-trigger on `ready` + Inngest function + Meta destination default, `product_id` attribution on checkout/order + funnel scope.
- ⏳ Operator steps to go live: apply migration `20260615120000_advertorial_pages.sql`; `PUT /api/inngest` to sync the new function; run a real generation to confirm Opus copy + hero signing; A/B advertorial-lander vs standard PDP (does the 86%→24% cliff shrink?).
- ⏳ Not yet: campaign-page UI to preview/regenerate a lander; regenerate-on-edit; angle-aware sticky-nav labels; a permanent per-product ingredient-hero set (currently reuses `product_media`).

## Related
[[storefront-checkout]] · [[ad-render]] · [[ad-static]] · [[ad-publish]] · [[../specs/killer-statics]] · [[../tables/advertorial_pages]] · [[../tables/product_ad_angles]] · [[../tables/ad_campaigns]] · [[../libraries/ad-angles]] · [[../libraries/ad-validator]]
