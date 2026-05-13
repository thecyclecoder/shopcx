-- Upsell product + AI complementarity copy.
--
-- A product can declare ONE upsell partner (another product in the
-- same workspace). When set, the storefront PDP renders:
--   1. An UpsellChapter between the primary chapters and the price
--      tables — lightweight pitch for the partner product.
--   2. A BundlePriceTableSection below the primary price table —
--      two cards (Bundle-1 = 1+1, Bundle-2 = 2+2) that read the
--      primary's existing pricing_rules to compute quantity-tier
--      discounts. No bundle-specific tier rules required.
--
-- upsell_complementarity shape (admin can edit after AI generation):
--   {
--     "headline": "Better together",
--     "intro": "1-2 sentence paragraph (~40 words)...",
--     "bullets": ["...", "...", "..."]
--   }

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS upsell_product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS upsell_complementarity JSONB;

CREATE INDEX IF NOT EXISTS products_upsell_product_id_idx
  ON public.products(upsell_product_id) WHERE upsell_product_id IS NOT NULL;
