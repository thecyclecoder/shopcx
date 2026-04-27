-- Bestseller flag for products. Surfaces a "Best Seller" badge on the
-- storefront PDP hero. Toggleable per-product from the dashboard product page.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_bestseller BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_bestseller
  ON public.products(workspace_id, is_bestseller) WHERE is_bestseller = true;
