-- Capture Shopify's Standard Product Taxonomy category + tax-related
-- flags on the product/variant rows so we can classify items for
-- Avalara without re-querying Shopify on every transaction.
--
-- `shopify_category` holds the full taxonomy name (e.g.
-- "Health & Beauty > Health Care > Fitness & Nutrition > Vitamins & Supplements").
-- It's the input to the classifier in `src/lib/avalara-tax-codes.ts`
-- that derives `products.avalara_tax_code`.
--
-- `shopify_category_id` is the Shopify GID (e.g.
-- "gid://shopify/TaxonomyCategory/...") — stable across Shopify
-- catalog name changes, so worth keeping as a join key.
--
-- `products.taxable` is the rolled-up flag (all variants taxable).
-- `product_variants.taxable` is the per-variant flag — Shipping
-- Protection's "Two-Way Protection" variant is taxable=false in
-- Shopify and we want to honor that.
--
-- `product_variants.shopify_tax_code` mirrors Shopify's `taxCode`
-- field (typically empty for us, but populated for merchants on
-- Shopify Plus + Avalara/Vertex). When present, it OVERRIDES the
-- category-based classifier.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS shopify_category TEXT,
  ADD COLUMN IF NOT EXISTS shopify_category_id TEXT,
  ADD COLUMN IF NOT EXISTS taxable BOOLEAN DEFAULT TRUE;

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS taxable BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS shopify_tax_code TEXT;

COMMENT ON COLUMN public.products.shopify_category IS
  'Shopify Standard Product Taxonomy full name. Input to avalara-tax-codes.ts classifier.';
COMMENT ON COLUMN public.product_variants.shopify_tax_code IS
  'Per-variant tax code from Shopify (Plus/Avalara integration field). When present, overrides the products.avalara_tax_code default for that variant.';
