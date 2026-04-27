-- Storefront favicon support.
--
-- The browser tab favicon should match the workspace's brand, not show
-- the ShopCX logo on a customer-facing page. Stored separately from
-- storefront_logo_url because:
--   1. logos are usually wide (renders cropped at 32x32)
--   2. favicons are usually square + small + tightly cropped
--   3. browsers prefer PNG/ICO at multiple sizes for tab/touch icons

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS storefront_favicon_url TEXT;
