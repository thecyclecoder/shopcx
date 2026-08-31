-- Relax product_reviews.shopify_product_id — it is a Klaviyo-era join key.
--
-- The column predates `product_id` (the internal FK we actually join on) and
-- was still NOT NULL with no default. The in-house review journey inserts by
-- `product_id`, so EVERY submit failed with a not-null violation, surfaced to
-- the customer as "something went wrong". Caught on the first real end-to-end
-- test; the API, validation, and journey were all fine.
--
-- Relaxing rather than only populating it: Shopify is being sunset, and a
-- future internal-only product with no shopify_product_id would reintroduce
-- the same failure. The handler still populates the column when the product
-- has one, so nothing that reads it regresses.
--
-- Reversible: widening a constraint. No data is touched, no column dropped.

ALTER TABLE public.product_reviews
  ALTER COLUMN shopify_product_id DROP NOT NULL;

COMMENT ON COLUMN public.product_reviews.shopify_product_id IS
  'Legacy Klaviyo-era join key. Nullable since the in-house review journey joins on product_id. Populated when the product has a Shopify id; null for internal-only products.';
