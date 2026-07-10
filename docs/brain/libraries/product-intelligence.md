# `src/lib/product-intelligence.ts`

The single READ front door for **every shred of product intelligence** on a product, denormalized for ad-creative generation — so every claim an ad makes is **verifiable by construction** (no fabrication, no human gate). Keyed on `products.id` (UUID). READ-ONLY.

Replaces the deprecated `product_intelligence` blob table (the ShopGrowth-era monolith — **dropped** 2026-07-10, migration `20260710000000_drop_legacy_product_intelligence.sql`; its one `source='shopgrowth'` row deleted first). This reads the rich structured surface built since.

## `getProductIntelligence(admin, workspaceId, productId)` → `ProductIntelligence`

Fans out (parallel) to every source and returns one object:

- **product** — [[../tables/products]]: title, rating/rating_count, is_bestseller, `target_customer` (demographic avatar), `certifications[]`, `allergen_free[]`, `awards[]`, `physical_dimensions`. The structured proof stack.
- **benefits** — [[../tables/product_benefit_selections]]: lead/support benefits, each with `customer_phrases[]` + linked `customer_review_ids[]` + `ingredient_research_ids[]` (claims backed by *both* science and real reviews). The canonical claim list a hook must anchor to.
- **ingredients** / **ingredientResearch** — [[../tables/product_ingredients]] (dosages) + [[../tables/product_ingredient_research]] (`benefit_headline`, `mechanism_explanation`, `clinically_studied_benefits`, `citations`, `contraindications`). The science spine.
- **adAngles** — [[../tables/product_ad_angles]]: ready-made LF8 hooks (`pain_now` → `desired_outcome`, `proof_anchor`, `enemy`) + length-capped `meta_headline`/`meta_primary_text`/`meta_description`. (Present for Coffee; **empty for Tabs → surfaced in `gaps`**.)
- **pageContent** — [[../tables/product_page_content]] (latest `status='published'`): hero lines, benefit bar, mechanism copy, comparison table, `expectation_timeline`, `endorsements`, `before_after_stories`, `guarantee_copy`, and `kb_what_it_doesnt_do` (**built-in claim guardrails**).
- **reviewAnalysis** + **reviews** — [[../tables/product_review_analysis]] (claim clusters: `top_benefits[{benefit, frequency, review_ids[], customer_phrases[]}]`, `skeptic_conversions`, `most_powerful_phrases`) + helpers over [[../tables/product_reviews]]: `featured`, `recentFiveStar`, `withPhotos`, and **`byClaim(benefitName)`** (lazy — resolves a cluster's `review_ids` → verbatim reviews).
- **media** — [[../tables/product_media]] grouped `byCategory` (hero · ingredient · before_after · lifestyle · testimonial_photo · ugc · press_logo · mechanism) with a `bySlotPrefix()` fallback for historic NULL-category rows, plus `isolatedPackshots` (from `product_variants.isolated_image_url`).
- **blogPosts** — `posts` via `post_products` (science / how-it-works / recipes). **seoKeywords**, **variants** too.
- **gaps** — sources empty for this product, surfaced (never silently swallowed).

`resolveProductIdByHandle(admin, workspaceId, handle)` — slug (`amazing-coffee`) → `products.id`.

## Who uses it

The ad-creative agent (keeps Bianca's [[media-buyer-agent|Media Buyer]] ready-to-test bin stocked with fully-backed creatives) — the whole point: this rich data was consumed by the PDP/orchestrator but **not** the ad pipeline. See [[../functions/growth]] · [[meta-scaling-methodology|../reference/meta-scaling-methodology]] · [[../lifecycles/product-intelligence]] (generation side).
