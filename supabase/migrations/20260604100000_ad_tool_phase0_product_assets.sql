-- Ad tool — Phase 0: product asset prep.
--
-- The hero generation in the ad builder (Higgsfield Soul) is only as good as
-- the product reference we feed it. Catalog images are packaging mockups with
-- backgrounds/shadows; Soul interprets those as "draw the avatar holding a flat
-- rendered mockup." Two upstream additions fix this:
--
--   1. A per-variant *isolated* image (product alone, transparent/white bg) that
--      gets passed as reference_image_urls[] to Soul.
--   2. Physical dimensions so the Soul prompt can constrain object size (diffusion
--      models default everything to "drink-can-sized" — coffee bags come out the
--      size of a sandwich).
--
-- Dimensions live on products (the common case: one physical SKU per product)
-- with an optional per-variant override (12oz bag vs 5lb bag of the same coffee).
-- Variant-level wins when set; product-level is the fallback.

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS isolated_image_url TEXT,
  ADD COLUMN IF NOT EXISTS isolated_image_uploaded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS isolated_image_uploaded_by UUID,
  ADD COLUMN IF NOT EXISTS physical_dimensions JSONB;

COMMENT ON COLUMN public.product_variants.isolated_image_url IS
  'Supabase Storage URL of the variant photographed alone on a transparent/white background, centered, no shadow. Passed as reference_image_urls[] to Higgsfield Soul in the ad builder.';
COMMENT ON COLUMN public.product_variants.physical_dimensions IS
  'Optional per-variant override of products.physical_dimensions. Shape: { length_in, width_in, height_in, weight_oz?, shape: bag|box|bottle|jar|pouch|other }. NULL = inherit from product.';

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS physical_dimensions JSONB;

COMMENT ON COLUMN public.products.physical_dimensions IS
  'Physical size of the product, baked into the Higgsfield Soul prompt so the model scales the object correctly. Shape: { length_in, width_in, height_in, weight_oz?, shape: bag|box|bottle|jar|pouch|other }. Variant-level physical_dimensions overrides this when set.';
