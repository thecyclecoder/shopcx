-- Per-product storefront header settings. Header text defaults to product
-- title; merchant can override the label, color, and font weight from the
-- admin product page. Weight is constrained client-side to the weights
-- actually preloaded for the workspace's chosen font.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS header_text TEXT,
  ADD COLUMN IF NOT EXISTS header_text_color TEXT,
  ADD COLUMN IF NOT EXISTS header_text_weight TEXT;
