# Review Filter Pill Counts — show the real corpus volume ✅

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
- On the Superfood Tabs PDP reviews section ("What customers are saying"), read the benefit pills → expect each count to be the corpus volume from `product_review_analysis.top_benefits[].frequency` (Bloating ~519, Weight ~407, Energy ~656, etc.), NOT the old 3–7.
- Click a benefit pill → expect the list to still show only that category's curated/loaded reviews (`benefit_review_matches[f]`), with a `Showing top reviews mentioning {category}` subhead directly above the grid.
- Click "All reviews" (or re-click the active pill) → expect the subhead to disappear and the full list to return; the "All reviews" pill behavior/total (`review_total_count`, 13k+) is unchanged.
- Inspect the pills list → expect no pill whose category has zero clickable reviews (benefits with no matched ids never enter `availableFilters`, unchanged).
- A benefit whose name matches a `top_benefits` cluster with no `frequency` → expect the pill to fall back to the matched-id count (no zero/blank count).

## Phases
- ✅ **P1:** `benefit_review_counts` in page-data (`computeBenefitReviewMatches` now returns `{ matches, counts }`; counts = summed `top_benefits[].frequency` of the same token-overlap name-match, fallback matched-id count) + ReviewsSection pill uses `data.benefit_review_counts[f]` + the `Showing top reviews mentioning {category}` subhead. Filter/click behavior (`benefit_review_matches`) and "All reviews" unchanged. Fold into [[../lifecycles/product-intelligence]] / the reviews-section notes on ship.
