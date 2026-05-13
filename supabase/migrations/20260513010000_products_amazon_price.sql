-- "Save $X buying direct" banner on the storefront price table compares
-- the Amazon list price against the direct-website price. Stored on
-- the product itself for now — manual admin entry in the intelligence
-- Overview tab. Future enhancement: auto-sync from amazon_asins
-- cached pricing once that caching is wired into the GET endpoint.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS amazon_price_cents INTEGER;
