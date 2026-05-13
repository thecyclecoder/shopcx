-- Admin-curated name shown as the H2 on the BundlePriceTableSection.
-- Stored on the PRIMARY product (the one customers shop) because the
-- bundle is anchored to the primary's pricing rule. Falls back to
-- "Add {upsell.title}" in render when unset.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS bundle_name TEXT;
