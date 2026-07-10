# Product intelligence lifecycle

How a product becomes a fully-researched, review-analyzed, PDP-ready knowledge asset that the AI orchestrator, KB articles, macros, storefront PDP, and now the **ad-creative pipeline** all read from. Single source of truth for "what does ShopCX know about each product, and how does that knowledge get built?" (A product is a first-class ShopCX entity keyed on its own `products.id` UUID — a Shopify sync was its *origin*, not its identity; it lives with or without Shopify, which is being sunset.)

> **Reading it all at once:** the [[../libraries/product-intelligence]] SDK (`getProductIntelligence`) is the single front door that fans out to every structured table below (benefits, ingredient research, ad angles, page content, categorized reviews, media) — built for ad-creative generation. The deprecated ShopGrowth-era `product_intelligence` *blob* table was **dropped** 2026-07-10 (migration `20260710000000`); the Engine's structured tables are canonical.

## The Engine — the only system

Intelligence lives in **seven normalized tables**, keyed by `product_id`, driven by a multi-stage Sonnet pipeline. The Engine UI lives at `/dashboard/products/[id]/intelligence`.

> **2026-06-03 — legacy ShopGrowth notes removed.** The Engine replaces a legacy free-form `product_intelligence` table that stored pasted ShopGrowth exports. All code paths (UI, API, macro-audit Inngest worker) that read or wrote that table were removed. The table itself + any rows in it still exist in the database (data not destroyed), but no application code references them anymore. The Engine is the canonical intelligence store.

## Engine pipeline — stage by stage

Tracked on `products.intelligence_status` (text enum). The Inngest functions and the Engine UI tabs are gated by this column.

```
none
  │  user adds ingredients on the Ingredients tab
  ▼
ingredients_added
  │  user clicks "Research" → fires intelligence/research-ingredients
  ▼
researching            ← polling status; UI ticks every 3s
  │  Sonnet returns per-ingredient research + citations
  ▼
research_complete
  │  user clicks "Analyze Reviews" → fires intelligence/analyze-reviews
  ▼
analyzing_reviews
  │  Sonnet reads product_reviews; writes product_review_analysis
  ▼
reviews_complete
  │  user picks lead + supporting benefits on the Benefits tab
  │  POST /benefit-selections writes product_benefit_selections
  ▼
benefits_selected
  │  user clicks "Generate Content" → fires intelligence/generate-content
  ▼
generating_content
  │  Sonnet writes product_page_content (hero, mechanism, ingredients,
  │  comparison, FAQ, guarantee, expectation timeline, endorsements,
  │  KB article, support macros)
  ▼
content_generated
  │  user clicks Approve → Publish on the Content tab
  ▼
published
```

Each transition is reversible: nothing is deleted on the way through, so you can re-run any stage. The `*_at` timestamp columns + `raw_ai_response` on every output table make replay trivial.

## The seven Engine tables

| Table | Purpose | Cardinality |
|---|---|---|
| [[../tables/product_ingredients]] | Per-product ingredient list (name, dosage, order) | Many per product, user-curated |
| [[../tables/product_ingredient_research]] | Per-ingredient research: mechanism, clinical benefits, citations, dosage comparison, contraindications, AI confidence | One per ingredient (regenerated on re-research) |
| [[../tables/product_review_analysis]] | Aggregate review-mining: top_benefits, before_after_pain_points, skeptic_conversions, surprise_benefits, most_powerful_phrases | One per product |
| [[../tables/product_benefit_selections]] | User's chosen lead + supporting benefits with role + science_confirmed + customer_confirmed flags + supporting evidence (review IDs + ingredient research IDs) | Many per product |
| [[../tables/product_how_it_works]] | Stepped "How it works" PDP section content | Many per product |
| [[../tables/product_page_content]] | Generated PDP block: hero, mechanism, ingredient cards, comparison table, FAQ, guarantee, expectation timeline, endorsements, FDA disclaimer, KB article, support macros, SEO meta. Versioned. | Many per product (each generate creates a new version) |
| [[../tables/product_benefit_angles]] | Per-product benefit angles (positioning variants for testing) | Many per product |
| [[../tables/product_seo_keywords]] | Generated SEO keyword research (separate but related Inngest function) | Many per product |

Plus a separate body of media: [[../tables/product_reviews]] (the input to review analysis) and [[../tables/product_media]] (assets attached to PDP blocks).

## Inngest functions (all event-triggered)

All in `src/lib/inngest/product-intelligence.ts` unless noted. Model used everywhere: **Sonnet** (constant `SONNET = SONNET_MODEL`).

| Function | Event | Reads | Writes |
|---|---|---|---|
| `researchIngredients` | `intelligence/research-ingredients` | [[../tables/product_ingredients]] | [[../tables/product_ingredient_research]] (one row per ingredient), `products.intelligence_status = research_complete` |
| `analyzeReviews` | `intelligence/analyze-reviews` | [[../tables/product_reviews]] | [[../tables/product_review_analysis]] (one row per product), `products.intelligence_status = reviews_complete` |
| `generateContent` | `intelligence/generate-content` | [[../tables/product_ingredient_research]], [[../tables/product_review_analysis]], [[../tables/product_benefit_selections]] | [[../tables/product_page_content]] (new version), [[../tables/product_how_it_works]], `products.intelligence_status = content_generated` |
| `researchBenefitGap` | `intelligence/research-benefit-gap` | Existing research + a missing benefit | [[../tables/product_ingredient_research]] (additional row) |
| `seoKeywordResearch` (in `src/lib/inngest/seo-keyword-research.ts`) | `seo/research-keywords` | Product context | [[../tables/product_seo_keywords]] |

All registered in `src/app/api/inngest/route.ts`. The UI fires these via POST endpoints under `/api/workspaces/[id]/products/[productId]/...`.

### Robustness (2026-06-12 fixes)
- **`researchIngredients` is fault-isolated per ingredient.** Each ingredient runs in its own `step.run` **wrapped in try/catch** — a slow/timed-out Sonnet call that fails after its retries no longer aborts the whole function (which had stranded 12 of 16 Superfood Tabs ingredients). Failed ingredients are collected + returned; the rest still research. (The per-ingredient delete-before-insert already makes re-research idempotent — multiple rows per ingredient are **one row per benefit**, by design, not duplicates.)
- **`analyzeReviews` is map-reduce over chunks.** A single pass over ~500 reviews **truncated** the JSON at `max_tokens` (`stop_reason: max_tokens`) → unparseable → empty output. Now: fetch **4+ star** reviews only, ordered by rating then longest-body (the gems), up to 2000; analyze in **chunks of 200** (each its own step, no truncation); **merge programmatically** (top_benefits summed by name; phrases/skeptics/surprises concatenated, deduped, capped; quotes still validated as exact substrings against the full set).
- **`target_customer` auto-fills from real purchaser demographics.** The overview (`intelligence-overview` route) fills a blank `products.target_customer` from `getProductDemographicBasis(productId)` (in [[../libraries/ad-avatar-proposals]] — the dominant gender / age / life-stage / income of actual buyers, reusing the avatar tool's cached per-product demographic basis), formatted by `describeTargetCustomer`. e.g. Superfood Tabs → *"Primarily female (86%), ages 45-54, family, 60-80k income — based on 906 purchasers."*

## API surface

Under `/api/workspaces/[id]/products/[productId]/`:

| Endpoint | Purpose |
|---|---|
| `intelligence-overview` | Single fetch the detail page uses — joins overview from all 7 tables |
| `ingredients` (+ `[ingredientId]`, `reorder`) | CRUD on the ingredient list |
| `research` | POST fires `intelligence/research-ingredients`; status check returns whether running |
| `research-gap` | POST fires `intelligence/research-benefit-gap` for a specific missed benefit |
| `analyze-reviews` | POST fires `intelligence/analyze-reviews` |
| `review-analysis` | GET the latest review analysis |
| `benefit-selections` | GET/POST the user's lead + supporting benefit picks |
| `generate-content` | POST fires `intelligence/generate-content` |
| `page-content/[contentId]/{approve,publish}` | Move a generated page through draft → approved → published |
| `regenerate-field` | Regenerate a single field of `product_page_content` (hero headline, FAQ, etc.) without re-running the full pipeline |
| `generate-complementarity` | Generate `products.upsell_complementarity` blurb for the cross-sell hint |
| `seo-keywords` | GET stored SEO keywords + POST to refresh |
| `link-group` | Manage product_link_group membership for bundle / collection cross-refs |

## Storefront → Products surfaces

There are **two product list pages** in the dashboard, with different purposes:

| Route | Purpose | Linked to |
|---|---|---|
| `/dashboard/storefront/products` | Catalog manager — status filter (active/draft/archived), variants, prices, intelligence pill | `/dashboard/storefront/products/[id]` (variant editor + storefront fields) |
| `/dashboard/products` | Intelligence work surface — all products, with intelligence-status filter + pill | `/dashboard/products/[id]/intelligence` (the Engine) |

The two lists pull from the same `products` table; only the click-through differs. The "Storefront Products" list is for editing catalog details (variants, prices, status); the "Products" (Knowledge → Products) list is for working the intelligence pipeline.

Two separate sidebar links:
- Storefront → Products → `/dashboard/storefront/products`
- Knowledge → Products → `/dashboard/products`

## Who reads the intelligence?

| Reader | Reads from | Purpose |
|---|---|---|
| `/dashboard/products/[id]/intelligence` page | All 7 Engine tables via `intelligence-overview` | Authoring surface |
| Storefront PDP renderer (custom storefront, in progress) | `product_page_content` (status='published') | Live PDP HTML/blocks |
| Knowledge base article generator | `product_page_content.knowledge_base_article` | Push the generated KB article into [[../tables/knowledge_base]] |
| AI orchestrator (Sonnet) | KB article + macros (not the Engine directly, yet) | Answers customer questions about the product |
| `products.upsell_complementarity` | Generated separately via `generate-complementarity` | Cross-sell hint shown at checkout |

The orchestrator does *not* read the Engine tables directly today. It reads KB articles and macros, which were authored from Engine outputs. The KB pipeline is the bridge.

## Key design choices

### Single canonical store
There used to be two stores (legacy ShopGrowth notes + the Engine). The legacy store was opaque to anything but the macro auditor, blocked migration to a structured PDP, and confused the dashboard surfaces. Removed entirely 2026-06-03.

### Status enum is single-source-of-truth for what's done
`products.intelligence_status` is the gate: the UI tabs at the top of the Engine page are enabled/disabled based on which stages have data. You can't pick benefits before reviews are analyzed; you can't generate content before benefits are picked. The DB is the spec — this enum drives every tab + button state.

### Re-runnable + replayable
Every output table has a `raw_ai_response` column and an `*_at` timestamp. Re-running a stage replaces the previous output but keeps the timestamp + raw response, so you can inspect what the model saw and replay.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/product-intelligence.ts` | All four Engine workers (research, reviews, content, benefit gap) |
| `src/lib/inngest/seo-keyword-research.ts` | SEO worker, separate file |
| `src/app/api/workspaces/[id]/products/[productId]/*` | 20+ endpoints for each pipeline stage |
| `src/app/dashboard/products/page.tsx` | All-products list with intelligence pill (Knowledge → Products) |
| `src/app/dashboard/products/[id]/intelligence/page.tsx` | The Engine — multi-tab authoring surface |
| `src/app/dashboard/storefront/products/page.tsx` | Catalog manager list (Storefront → Products) |
| `supabase/migrations/*_product_*.sql` | Schema for all 7 Engine tables |

## Status / open work

**Shipped:**
- Engine pipeline end-to-end: ingredients → research → review analysis → benefit selections → page content + KB article + macro list → publish.
- **Box-driven seeding ([[../specs/box-product-seeding]]) — on Max:** a separate path from this Inngest Engine. [[../tables/agent_jobs]] `kind='product-seed'` → `runProductSeedJob` launches a **top-level `claude -p` on Max** (web search, no `ANTHROPIC_API_KEY`) running the **`seed-product` skill**, which does the LLM work agentically (web-search ingredient research, review analysis, benefit triangulation, content, hero vision-QA) and calls the deterministic `scripts/seed-product-tools.ts` → [[../libraries/product-intelligence-seed|`seed-tools.ts`]] for all I/O. One "Auto-populate" click drives a product `none → published`: PDP-extracted ingredients → web research → reviews → triangulated benefit selection → content → Nano Banana Pro hero ([[../libraries/google-drive]] packshots) → self-QA gate → auto-publish. Hero gen is locked-skip for Amazing Coffee / pods / Creamer. **No Anthropic API, no Inngest, no per-token spend on the box.**
- `intelligence_status` enum drives UI tab gating.
- **PDP refinement pass — global build (P1, [[../specs/pdp-refinement-pass]]):** the repeatable per-product polish layer on top of seeding. Shipped in the seed/storefront code: centered `WhatToExpectTimeline` (cols = min(steps,5)); up to 2 before/after stories (`before_{n}`/`after_{n}` media + `product_page_content.before_after_stories`); the hero "N superfoods" credibility badge excludes caffeine-style duplicates; individual trust pills (`saveTrustPills` splits comma-joined `certifications`/`allergen_free`, + one-time split migration); full-corpus review analysis (`getReviews` range-pagination, no 1000-row cap); per-variant Supplement Facts → `get_product_nutrition` orchestrator tool + KB mirror on publish; PDP harvest (`pdp-images` + `rehostImage` — re-host endorsements + before/after, never hotlink); hero gallery slide generators (`resolveLifestyleSlide` Drive UGC + `generateStaticAdSlide` Nano-Banana w/ caption overlays). Per-product runs (P2 Tabs, P3 fan-out) + nutrition-facts publishing are gated on founder verification.
- **Review filter pill counts reflect real corpus volume (review-pill-counts):** the storefront PDP "What customers are saying" benefit pills (`src/app/(storefront)/_sections/ReviewsSection.tsx`) show each category's **corpus mention count** from [[../tables/product_review_analysis]] `top_benefits[].frequency` (hundreds — e.g. Tabs Bloating ~519), not the tiny displayed-match set. `computeBenefitReviewMatches` (`_lib/page-data.ts`) now returns `{ matches, counts }`; `counts` sums the `frequency` of the same token-overlap name-match used to map a [[../tables/product_benefit_selections]] `benefit_name` to its analysis cluster, exposed as `PageData.benefit_review_counts` and falling back to `matches[name].length` when no `frequency` match. **Filter/click behavior is unchanged** — clicking still shows the curated `benefit_review_matches[f]` sample, now under a *"Showing top reviews mentioning {category}"* subhead so the big number isn't misread as the listed count; the "All reviews" pill keeps the true `review_total_count`. Part of the [[../specs/pdp-refinement-pass|PDP refinement]] family.
- Both list views (`/dashboard/products` and `/dashboard/storefront/products`) show intelligence-status pills.
- Legacy ShopGrowth UI + API + macro-audit Inngest worker removed (2026-06-03).

**Known gaps / not yet shipped:**
- AI orchestrator doesn't read the Engine directly — it reads downstream KB articles + macros. Could read `product_page_content.faq_items` or `product_review_analysis.top_benefits` directly for richer answers.
- No bulk operations on the Engine — research-all, analyze-reviews-all, etc. Each is per-product.
- `product_page_content.published_at` exists but the storefront renderer that consumes it is a separate WIP (custom storefront, see [[storefront-checkout]]).
- The legacy `product_intelligence` table + any rows in it remain in the database (data preserved). DB drop / row purge is a separate cleanup step — not done in the same commit as the code removal.

**Recent activity:**
- 2026-06-03 — `/dashboard/products` list switched from `product_intelligence`-driven to `products`-driven. Legacy ShopGrowth UI (detail page + new page), API (`/api/workspaces/[id]/product-intelligence/*`), and Inngest worker (`macro-audit.ts`) removed entirely. No code references the legacy table anymore.

## Related

[[../tables/products]] · [[../tables/product_ingredients]] · [[../tables/product_ingredient_research]] · [[../tables/product_review_analysis]] · [[../tables/product_benefit_selections]] · [[../tables/product_how_it_works]] · [[../tables/product_page_content]] · [[../tables/product_benefit_angles]] · [[../tables/product_seo_keywords]] · [[../tables/product_reviews]] · [[../inngest/product-intelligence]] · [[../inngest/seo-keyword-research]] · [[../dashboard/products]] · [[../dashboard/storefront__products]] · [[storefront-checkout]]
