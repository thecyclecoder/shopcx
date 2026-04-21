-- Responsive image variants for product_media.
-- Upload pipeline writes AVIF + WebP at 640 / 1200 / 1920 widths; the
-- storefront uses <picture>/<source srcset> to serve the smallest
-- correct file to each viewport without going through any optimizer.

ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS avif_640_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_640_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_640_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_640_storage_path TEXT,

  ADD COLUMN IF NOT EXISTS avif_1200_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_1200_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_1200_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_1200_storage_path TEXT,

  ADD COLUMN IF NOT EXISTS avif_1920_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_1920_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_1920_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_1920_storage_path TEXT;
