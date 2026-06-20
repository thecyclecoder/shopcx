-- Lander refinements (round 3): per-product survey gate + comparison competitor label.
--
-- 1) show_survey — the SurveyChapter is hardcoded coffee-specific ("1 cup/2 cups",
--    coffee styles), so it must NOT render for non-coffee products. Default false;
--    render-page guards on it. Set true ONLY for the coffee products below.
-- 2) comparison_competitor_label — the ComparisonSection rival column was hardcoded
--    "Regular Coffee" (wrong for non-coffee). NULL falls back to "Regular Coffee" in
--    the renderer (correct for the coffee products); the seed pipeline populates a
--    per-product label for everything else (e.g. "Coffee & Energy Drinks").
ALTER TABLE public.product_page_content
  ADD COLUMN IF NOT EXISTS show_survey boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS comparison_competitor_label text;

-- Backfill: the survey is only valid for the two coffee products (Amazing Coffee +
-- Amazing Coffee K-Cups/pods). Everything else stays false (the new default).
UPDATE public.product_page_content AS pc
SET show_survey = true
FROM public.products AS p
WHERE p.id = pc.product_id
  AND p.handle IN ('amazing-coffee', 'amazing-coffee-pods');
