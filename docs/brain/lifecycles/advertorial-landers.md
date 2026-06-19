# Lifecycle: auto-generated ad-matched landers (advertorial + before/after)

Turns an advertorial / before-after / ingredient-breakdown **ad** into a scent-matched **landing page** so the cold-50+ click doesn't bounce on the standard branded PDP. A lander is a **layout mode of the PDP** reached via `?variant=advertorial|beforeafter|reasons&angle={slug}`: only the editorial TOP (hero + chapter 1, or the numbered reasons list) is generated; everything below it (ingredients, price table, reviews, checkout) is the existing PDP, reused unchanged. Per ad *angle*, reused across all campaigns/ads of that angle. Targets the proven **86%→24% hero cliff** (funnel evidence in the spec).

**Code:** `src/lib/advertorial-pages.ts` (reader + generator) · `src/lib/inngest/ad-tool.ts` (`adToolAdvertorialPageRequested`, auto-trigger on `ready`) · `src/app/(storefront)/_lib/render-page.tsx` (layout branch) · `src/app/(storefront)/_sections/AdvertorialHero.tsx` · `AdvertorialChapter.tsx` · `BeforeAfterHero.tsx` · `WeightLossTestimonialWall.tsx` · `ReasonsListicle.tsx` · `src/app/(storefront)/_components/StickyJumpNav.tsx` · `src/app/api/ads/campaigns/[id]/advertorial/route.ts`. **Table:** [[../tables/advertorial_pages]].

## Flow

1. **Trigger** — when a campaign reaches `ready` ([[ad-render]]), `adToolRenderRequested` fires `ad-tool/advertorial-page-requested`. (Also on demand: `POST /api/ads/campaigns/[id]/advertorial`.)
2. **Generate** — `generateAdvertorialPagesForCampaign(workspaceId, campaignId)`:
   - Loads the campaign's angle (`product_ad_angles`) + the five PI tiers (`loadAngleInputs`, [[../libraries/ad-angles]]) + the campaign's `hero_image_url` + `script_text`.
   - `generateAdvertorialNarrative` — Opus generates the editorial **headline + dek + chapter-1 narrative** (problem → mechanism/story → proof) from the *same* angle + PI + ad script (so the lander is scent-matched by construction), gated through `validateAdScript` ([[../libraries/ad-validator]]) for banned words. Deterministic PI fallback when the API is off → the lander always renders.
   - **Hero auto-pick by angle:** testimonial/transformation/social-proof → the avatar holding-product shot (`ad_campaigns.hero_image_url`, persisted as a re-signable `ad-tool` path); mechanism/curiosity/clinical → an ingredient shot (resolved from `product_media` at render).
   - Always builds the **advertorial** + the **reasons** ("8 Reasons Why") landers; additionally builds the **before/after** lander when the product has real `before`/`after` `product_media`.
   - **Persist** an [[../tables/advertorial_pages]] row per variant, keyed `(workspace_id, product_id, slug)`. `slug = {hook_slug}-{angle_id[:8]}` (readable + unique); the before/after row appends `-ba`.
3. **Render** — the storefront route reads `?variant` + `?angle`; `loadAdvertorialContent(data, variant, slug)` resolves the persisted row (re-signing the hero `ad-tool` path), falling back to PI-derived content. `StorefrontPage` branches on `advertorial`:
   - **advertorial:** `AdvertorialHero` (editorial serif masthead, SPONSORED label) → `StickyJumpNav` → `AdvertorialChapter` (narrative + drop cap) → reuse `IngredientsSection` + `PriceTableSection` + `ReviewsSection` + `FinalCTASection` + `BrandTrustSection`.
   - **beforeafter:** `BeforeAfterHero` (real before/after panels) → `HeroSection` (the PDP hero, **reused as the product intro / chapter 2** — introduce the product right after the transformation hook) → `StickyJumpNav` → `WeightLossTestimonialWall` (5★ reviews filtered to weight/appearance) → reuse ingredients/pricing/final-CTA/trust.
   - **reasons:** `AdvertorialHero` (editorial) → `ReasonsListicle` (a numbered **1–8** list — filled accent number badges, serif headings, hairline dividers, a CTA mid-list after #4 + a closing CTA card) → reuse `IngredientsSection` + `PriceTableSection` + reviews + checkout. The scent-match for the **ingredient-breakdown** ad ("here's exactly what's inside / why it works", erth.labs `learn.erthlabs.co/reasons2` style).
   - Every new section carries `data-section` → auto-instrumented by `StorefrontChapterTracker` (funnel + A/B free). The sticky nav's "See pricing" carries `data-cta-kind="scroll_to_price"` so jump-aware tracking credits the jump.
4. **Ad → lander wiring** — `POST /api/ads/campaigns/[id]/publish` defaults `destination_url` to `advertorialLanderUrl(workspaceId, campaignId)` (the angle's advertorial lander on the custom domain, else `shopcx.ai/store/{slug}/{handle}`). An explicit operator destination still wins.

## Attribution prerequisite (shipped here)
`checkout_view` + `order_placed` now carry `product_id` (the highest-value cart line): client `CheckoutClient.tsx` (both events) + server `api/checkout/route.ts` (canonical `order_placed`, top-level column + meta). `GET /api/workspaces/[id]/storefront-funnel?product_id=…` scopes the whole funnel per product — so advertorial-lander → purchase is measurable per product (previously read 0 below `pack_selected`).

## ISR / routing
The route reads `searchParams` but still no headers/cookies → param-less PDPs stay statically generated (`generateStaticParams`); only `?variant=…` requests render dynamically. Custom domains rewrite via middleware to `/store/{workspace}/{slug}`, preserving the query.

## Copy rules (shared with [[../specs/killer-statics]])
Anchor to the CORE desires — **weight loss · fighting aging · best self · social approval** — never functional energy/no-crash/focus. **Review counts display as actual + 10,000** (`displayReviewCount`). Reuse real `product_media` (endorser photo, before/after, ingredient shots). One `generateAdvertorialNarrative(angle)` feeds the lander (and is the sibling of the advertorial-static copy).

## The "8 Reasons Why" listicle (reasons variant)
Added 2026-06-16 as the third lander template. Opus generates the 8 reasons (`generateAdvertorialNarrative` reasons branch) from the *same* angle + PI tiers, anchored to the core desires; deterministic PI fallback (`reasonsFallback`, built from `lead_benefits` + `ingredient_science`). Stored in `advertorial_pages.reasons` jsonb (migration `20260616120000_advertorial_pages_reasons.sql`); slug is `{base}-reasons`. Reached via `?variant=reasons&angle={slug}`. Decisions (Dylan, 2026-06-16):
- **Headline always leads with "8 Reasons Why"** — `eightReasonsHeadline()` coerces Opus output + the fallback, never the product's `hero_headline` (which reads broken: "8 Reasons Why Brew. Sip…").
- **Hero = a Nano Banana Pro composite** — `ensureReasonsHero()` composites the product's REAL isolated pouch into a warm lifestyle coffee scene (same approach as the auto-blog hero — reuses `gemini` + `compressToWebp` from [[../libraries/blog__generate-images]]), WebP → public `product-media/workspaces/{ws}/landers/{handle}/reasons-hero.webp`, reuse-if-present (HEAD check). Stored as the row's `hero_storage_path` (the public URL passes straight through the reader). Falls back to the ingredient/avatar media hero if no isolated pouch / gen fails.
- **Banned-word gate is RELAXED for the listicle** — editorial copy legitimately uses "supports/helps/natural" (trustworthy 50+ language); the `DEFAULT_BANNED_WORDS` soft-word list is for punchy *spoken* hooks. The reasons branch gates only on a workspace's EXPLICIT banned words (filters the soft-word defaults out before matching). `callOpus` `max_tokens` raised to 3000 (8 reasons truncated at 1300 → JSON.parse fail → silent fallback).

## Decisions / gotchas
- **Per angle, not per campaign** — landers upsert by `(product_id, slug)`, so re-running a campaign of the same angle refreshes rather than duplicates.
- **Hero paths, not signed URLs** — only re-signable `ad-tool` paths are persisted (`hero_storage_path`); expiring signed URLs are dropped so the reader can always re-sign fresh. Ingredient/before-after heroes resolve from `product_media` at render.
- **Reused sections untouched** — the sticky nav scrolls to `[data-section="ingredients"]` / `#pricing` via a client handler, so `IngredientsSection` / `PriceTableSection` need no edits.
- **Auto-design scope = hero + chapter 1 only.** The dead mid-chapters (ugc/comparison/endorsement) are intentionally NOT carried into the lander.

## Status / open work

**Shipped:** Verified + archived 2026-06-18 ([[../archive]]). Landers auto-generate when a campaign hits `ready` — three variants (advertorial · before/after · "8 Reasons Why"), all layout modes of the PDP reusing ingredients/pricing/reviews/checkout. P1–P4 live: layout modes + sections, generator + `advertorial_pages` (+ `reasons` jsonb) migrations applied, API route, auto-trigger Inngest function synced (`PUT /api/inngest`), Meta destination default, `product_id` attribution on checkout/order + per-product funnel scope.

**Known gaps / not yet shipped:**
- A/B run (advertorial lander vs standard PDP — does the 86%→24% cliff shrink?) accrues over time.
- Campaign-page UI to preview/regenerate a lander; regenerate-on-edit; angle-aware sticky-nav labels.
- A permanent per-product ingredient-hero set (advertorial/beforeafter currently resolve the ingredient hero from `product_media`; the reasons variant generates its own NBP hero).

**Open questions:** None.

## Related
[[storefront-checkout]] · [[ad-render]] · [[ad-static]] · [[ad-publish]] · [[../specs/killer-statics]] · [[../tables/advertorial_pages]] · [[../tables/product_ad_angles]] · [[../tables/ad_campaigns]] · [[../libraries/ad-angles]] · [[../libraries/ad-validator]]
