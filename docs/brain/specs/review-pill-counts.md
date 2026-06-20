# Review Filter Pill Counts — show the real corpus volume ⏳

**Owner:** [[../functions/cmo]] · **Parent:** CMO mandate — owned product/website content (PDP family; follows [[pdp-refinement-pass]] / [[box-product-seeding]]).

The "What customers are saying" filter pills show a **count next to each benefit category**, but it's computed from the tiny *displayed-match* set, not the full review corpus — so Superfood Tabs shows "Reduced Bloating **7**" when the analysis found **~519** reviews mention bloating (out of 2,770 analyzed). Make the pill count reflect the **real corpus volume** so the social proof lands.

## Root cause (exact)
- `src/app/(storefront)/_sections/ReviewsSection.tsx:226` → `const count = matches[f]?.length || 0;` — `matches` = `benefit_review_matches` (a small set of review_ids used to *filter* the displayed reviews), so the count is bounded by the handful of featured/loaded reviews that matched.
- The real per-category volume is already computed by the review analysis: `product_review_analysis.top_benefits[]` = `{ benefit, frequency, customer_phrases }` (`frequency` is the corpus count — hundreds). Exposed in page-data (`PageData.top_benefits`, page-data.ts:361). It's just not used for the pill count.

## Fix
- **page-data:** alongside `benefit_review_matches`, build **`benefit_review_counts: Record<string, number>`** keyed by the benefit-selection `benefit_name` → the matched `top_benefits[].frequency`. Reuse the **same** name-matching that `computeBenefitReviewMatches` already does to map a selection's `benefit_name` to its analysis cluster (so "Reduced Bloating & Digestive Comfort" → the bloating cluster's `frequency`). Fall back to `matches[name].length` when there's no frequency match.
- **ReviewsSection:** the pill **count displays `benefit_review_counts[f]`** (the corpus volume), not `matches[f].length`. The **filter behavior is unchanged** — clicking still shows the `benefit_review_matches[f]` reviews (the curated/loaded sample).
- **Honesty on click:** since the pill says e.g. "Reduced Bloating (519)" but the filter shows a sample, when a category is active show a small subhead like *"Showing top reviews mentioning {category}"* (or "Showing N of {frequency}") so the big number isn't misread as "519 reviews listed here." No fabrication — `frequency` is the analysis's real mention count.
- **"All reviews"** pill keeps the true total (`review_total_count`), unchanged.

## Verification
- Superfood Tabs reviews section: pills read the corpus volume (Bloating ~519, Weight ~407, Energy ~656, etc. — matching `top_benefits[].frequency`), not 3–7. Clicking a pill still shows that category's curated reviews with the "showing top reviews…" subhead. "All reviews" still shows 13k+. No category shows a count with zero clickable reviews (a benefit with frequency but no matched ids is hidden, as today via `availableFilters`).

## Phases
- ⏳ **P1:** `benefit_review_counts` in page-data + ReviewsSection pill uses it + the filtered subhead. Fold into [[../lifecycles/product-intelligence]] / the reviews-section notes on ship.
