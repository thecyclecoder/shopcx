# Auto-generated ad-matched landers (advertorial + before/after) 🚧

Status: 🚧 in progress (P1–P4 code-complete on branch `advertorial-landers`) · owner: Dylan · created 2026-06-15

> **Shipped on branch:** layout modes + sections, `advertorial_pages` generator + migration + API, auto-trigger on `ready` + Meta destination default, and the `product_id` checkout/order attribution fix. End-to-end trace folded into [[../lifecycles/advertorial-landers]] + [[../tables/advertorial_pages]]. Remaining = operator go-live steps (apply migration, `PUT /api/inngest` sync, real generation, A/B) + campaign-page preview UI. Delete this spec once those land and it's verified in production.

## Context — why this exists

We're running advertorial-style static ads to a **cold 50+** audience (see the killer-statics work: editorial serif, real-person/ingredient heroes, "looks like an article, not an ad"). Those ads only pay off if the **post-click page continues the same scent**. Sending advertorial clicks to the standard branded PDP breaks the illusion and bounces the exact audience that clicked *because* it looked like editorial content.

Two hard constraints from Dylan:
1. **Zero manual design.** The lander must be auto-generated *in conjunction with the ad creative*, reusing assets that already exist — never hand-built per campaign (hand-built landers drift from the ad and re-introduce the mismatch).
2. **Reuse, don't rebuild.** Reuse the ad's assets (angle, hero image, script) AND the PDP's working sections (ingredients, price table, reviews, checkout).

### The funnel evidence (Amazing Coffee, last 90d, PDP-scoped)
Pulled live from `storefront_events` (`scripts/_probe-funnel.ts`):

| Step | Sessions | % of PDP views |
|---|---|---|
| pdp_view | 715 | 100% |
| pdp_engaged | 377 | 52.7% |
| pack_selected | 22 | **3.1%** |

Chapter performance (the real signal):

| # | Chapter | Reach | view→price% |
|---|---|---|---|
| 0 | hero | **86%** | 12.9% |
| 1 | why-this-works | **24%** | 18.4% |
| 2 | ugc | 14% | 2.0% |
| 4 | ingredients | 6% | **20.0%** |
| 8 | pricing | 18% | — |

**Takeaways that drive the design:**
- **86% → 24% cliff at the hero.** Two-thirds leave without reading past the hero. Fixing this is the entire job of the lander.
- **Best closers (`why-this-works` 18.4%, `ingredients` 20%) are starved** (24% / 6% reach). Route narrative *into* them.
- **18% jump straight to pricing** (26s dwell) — fast-path-to-pricing is matching observed behavior, not optional.
- **Mid chapters (ugc/comparison/endorsement/expect) are dead weight** — low reach AND low conversion. Don't restyle them.

## Decisions locked (2026-06-15)
- **Page unit: per ad *angle*** (`product_ad_angles`), reused across all campaigns/ads of that angle. Hero pulled from a representative campaign of that angle.
- **Trigger: auto-generate when an ad campaign reaches `ready`.** Ad + matched lander come out together, zero manual step. (Regenerate-on-edit can come later.)
- **Auto-design scope: editorial hero + chapter 1 only.** Everything below (ingredients, price table, reviews, checkout) is the existing PDP, reused unchanged. Smallest, highest-leverage generation — aimed squarely at the hero cliff.

## Lander templates (ad-matched)
The ad's archetype determines the landing page (scent-match). Two lander templates beyond the PDP, both reuse the existing PDP sections below the custom top:

1. **Advertorial lander** — editorial hero (matches the advertorial ad: serif, same hero image/angle) + narrative chapter 1 → reuse `IngredientsSection` + `PriceTableSection` + checkout. For advertorial-archetype ads.
2. **Before/after lander** — for before/after ads (and weight-loss angles). Top = a **before/after transformation hero** (the real `before`/`after` `product_media`, framed as the ad), then the **PDP `HeroSection` reused as the product intro (chapter 2)** — introduce the product after the transformation hook — then a **wall of weight-loss testimonials** (real 5★ reviews filtered to weight/results — `product_reviews` body ILIKE weight/pounds/lost), then the **rest of the existing PDP** (ingredients → price table → guarantee → checkout). Continues the transformation scent the ad set up, then closes with proof + offer.

3. **Reasons listicle ("8 Reasons Why")** — *added 2026-06-16* — the scent-match for the **ingredient-breakdown** ad ("here's exactly what's inside / why it works", erth.labs `learn.erthlabs.co/reasons2` style). Top = editorial `AdvertorialHero` → **`ReasonsListicle` (new section)**: a numbered 1–8 list (filled accent number badges, serif headings, hairline dividers), CTA mid-list (after #4) + a closing CTA card → reuse `IngredientsSection` + `PriceTableSection` + reviews + checkout. Reached via `?variant=reasons&angle={slug}`. Decisions (Dylan, 2026-06-16):
   - **Headline always leads with "8 Reasons Why"** — `eightReasonsHeadline()` coerces Opus output + the fallback (never the product's `hero_headline`, which reads broken: "8 Reasons Why Brew. Sip…").
   - **Hero = a Nano Banana Pro Amazing Coffee image** — `ensureReasonsHero()` composites the product's REAL isolated pouch into a warm lifestyle coffee scene (same approach as the auto-blog hero, reuses `gemini` + `compressToWebp` from [[blog/generate-images]]), WebP → public `product-media/workspaces/{ws}/landers/{handle}/reasons-hero.webp`, reuse-if-present (HEAD check). Stored as the row's `hero_storage_path` (public URL passes straight through the reader). Falls back to the ingredient/avatar media hero if no isolated pouch / gen fails.
   - **Banned-word gate is RELAXED for the listicle**: editorial copy legitimately uses "supports/helps/natural" ("supports immune function" is trustworthy 50+ language); the `DEFAULT_BANNED_WORDS` DR soft-word list is for punchy *spoken hooks*, not this. The reasons branch gates only on a workspace's EXPLICIT banned words, never the soft-word defaults (filters them out before matching). `callOpus` max_tokens raised to 3000 (8 reasons were truncating at 1300 → JSON.parse fail → silent fallback).

   Opus generates the 8 reasons (`generateAdvertorialNarrative` reasons branch) from the *same* angle + PI tiers, anchored to the core desires; deterministic PI fallback (`reasonsFallback` from `lead_benefits` + `ingredient_science`). Stored in `advertorial_pages.reasons jsonb` (migration `20260616120000_advertorial_pages_reasons.sql`, applied). Slug `{base}-reasons`. `generateAdvertorialPagesForCampaign` now always builds advertorial **+ reasons** (+ before/after when real media exists).

All three are layout modes of the PDP (`?variant=advertorial|beforeafter|reasons&angle={slug}`, ISR-safe), reuse `getPageData()` + the existing sections, and auto-instrument via `data-section`. Testimonial/authority/big-claim ads → the **standard PDP** (no custom lander).

## Copy rules (shared with [[killer-statics]])
Anchor narrative to the CORE desires — **weight loss · fighting aging · best version of yourself · social approval** — never functional energy/no-crash/focus. **Review counts display as actual + 10,000** (2,291 → 12,291). Reuse real `product_media` assets (real endorser photo, before/after, ingredient shots). One `generateAdvertorialNarrative(angle)` should feed the ad caption, the advertorial static, and this lander.

## Architecture

### Generation: `(product + ad angle/campaign) → advertorial_page`
1. **Inputs** — the angle row (`product_ad_angles`: promise, hook formula, LF8 slot, `lead_benefit_anchor`), the campaign's `script_text` (already DR-validated), the five PI tiers (`loadAngleInputs`), and the campaign's assets.
2. **Copy** — Opus generates the **editorial hero headline + dek + chapter-1 narrative** (problem → mechanism/story → proof) from the *same* angle + PI tiers + ad script, then runs through the existing `validateAdScript`/angle validator (`src/lib/ad-validator.ts`) so claims stay anchored to PI. Reuse `ad-angles.ts` tier hydration. Serif/editorial voice — mirrors `remotion/StaticAdvertorial.tsx` copy discipline.
3. **Hero image — auto-picked by angle type** (no manual choice):
   - **Testimonial / transformation / social-proof angles** → the avatar holding-product shot (`ad_campaigns.hero_image_url`).
   - **Mechanism / curiosity / clinical angles** → an ingredient shot (the Nano Banana "hands-holding-chaga"/flat-lay heroes, already stored under `ad-tool/poc/advertorial-ingredient/` — promote to a permanent per-product ingredient-hero set).
   - Map off the angle's `hook_formula` / LF8 slot; operator override allowed but not required.
4. **Persist** — a generated `advertorial_pages` row (or `product_page_content` variant) keyed by `(product_id, angle_id)`: editorial headline, dek, chapter-1 blocks, chosen hero storage path, sticky-nav config.

### Rendering: an advertorial **layout mode** of the PDP
- New layout branch in `src/app/(storefront)/_lib/render-page.tsx` (`StorefrontPage`). Reached via an **ISR-safe URL param** `?variant=advertorial&angle={slug}` (the route reads no headers/cookies today — confirmed safe) or a thin separate route.
- Section stack: **`AdvertorialHero` (new)** → **`AdvertorialChapter` (new, narrative)** → reuse **`IngredientsSection`** + **`PriceTableSection`** + reviews + `FinalCTASection` + brand trust **unchanged** → **sticky jump-nav** ("Ingredients" · "See pricing") because 18% jump to price.
- Every new section gets `data-section="{id}"` so `StorefrontChapterTracker` instruments it automatically — funnel + A/B tracking is free.
- Hero/ingredient images rendered via the `SafeImg` pattern (fresh signed `ad-tool` URLs).

### Ad → lander wiring
- The Meta publish step (`src/lib/meta-ads.ts` / `ad-meta-copy.ts`) sets each ad's destination URL to its angle's advertorial lander (`…?variant=advertorial&angle={slug}`), so scent-match is guaranteed by construction.

## Prerequisite fix — checkout attribution
`checkout_view` / `order_placed` events fire on `/checkout` **without `product_id`**, so product-scoped funnels read 0 below `pack_selected`. **Fix before A/B judging:** carry `product_id` (or the selected pack's product) onto checkout/order events so we can measure advertorial-lander → purchase per product. Touches the checkout event emitters + `storefront-funnel` route.

## Measurement / A-B plan
- Run advertorial ads → advertorial lander **vs** advertorial ads → standard PDP.
- Primary: `pack_selected` rate + (post-fix) `order_placed` per product. Secondary: **hero→chapter-1 retention** (does the 86%→24% cliff shrink?), early-chapter `view_to_cta_pct`, `scroll_to_price`.
- All already computed by `GET /api/workspaces/[id]/storefront-funnel`.

## Phases
- 🚧 **P1 — Layout mode + sections.** ✅ `AdvertorialHero` + `AdvertorialChapter` + `BeforeAfterHero` + `WeightLossTestimonialWall` + `StickyJumpNav`; `?variant=advertorial|beforeafter` branch in `render-page.tsx` + the storefront route reads `searchParams`; reuse ingredients/pricing/reviews; `data-section` tracking. Reader (`loadAdvertorialContent`) with PI fallback so the layout always renders.
- 🚧 **P2 — Generator.** ✅ `advertorial_pages` table (migration `20260615120000`) + `generateAdvertorialNarrative`/`generateAdvertorialPagesForCampaign` (Opus, reusing `ad-angles`/`ad-validator`, deterministic fallback) + angle→hero auto-selection. `POST`/`GET /api/ads/campaigns/[id]/advertorial`.
- 🚧 **P3 — Auto-trigger.** ✅ Fires generation when a campaign hits `ready` (`adToolRenderRequested` → `ad-tool/advertorial-page-requested` → `adToolAdvertorialPageRequested`); publish route defaults `destination_url` to `advertorialLanderUrl`. ⏳ `PUT /api/inngest` sync needed to register the function.
- 🚧 **P4 — Attribution fix + A/B.** ✅ `product_id` on `checkout_view` + `order_placed` (client + server) + `?product_id` scope on `storefront-funnel`. ⏳ A/B run (advertorial lander vs standard PDP) + dashboard surfacing.

## Files to touch (anticipated)
- `src/app/(storefront)/_lib/render-page.tsx` — advertorial layout branch
- `src/app/(storefront)/_sections/AdvertorialHero.tsx`, `AdvertorialChapter.tsx` — new
- `src/app/(storefront)/_sections/IngredientsSection.tsx`, `PriceTableSection.tsx` — reused unchanged
- `src/lib/ad-angles.ts`, `ad-validator.ts` — reused for copy gen
- `src/lib/advertorial-pages.ts` — new generator lib
- `src/lib/inngest/ad-tool.ts` — auto-trigger on `ready`
- `src/lib/meta-ads.ts` / `ad-meta-copy.ts` — set ad destination URL
- checkout event emitters + `storefront-funnel/route.ts` — `product_id` on checkout/order
- migration: `advertorial_pages` table + permanent per-product ingredient-hero set
- brain: new `lifecycles/advertorial-landers.md` (or fold into `storefront-checkout` + `ad-render`) on ship

## Open questions
- One canonical ingredient-hero per product, or per ingredient-angle (chaga vs flat-lay vs turmeric)? Lean: a small reusable set per product, angle picks the best fit.
- Does the editorial copy generator share code with the **ad** advertorial-static copy (same angle → both ad caption + lander)? Likely yes — one `generateAdvertorialNarrative(angle)` feeding both.
- Sticky-nav labels/anchors — fixed ("Ingredients" / "See pricing") or angle-aware?

## Related
[[../lifecycles/storefront-checkout]] · [[../lifecycles/ad-render]] · [[../lifecycles/ad-static]] · [[../lifecycles/ad-publish]] · [[../tables/product_ad_angles]] · [[../tables/ad_campaigns]] · [[../lifecycles/product-intelligence]]
