-- Refine responsive variant widths from 640/1200/1920 to
-- 480/750/1080/1500/1920 — tighter coverage of real device/DPR combos
-- so each device lands on a variant within ~20% of its actual need.
--
-- 20260421000002 added 640/1200/1920 columns. This migration drops
-- 640 and 1200 (not yet written in production), adds 480/750/1080/
-- 1500, and leaves 1920 alone. Upload pipeline writes all five new
-- widths going forward; existing uploads fall through to the full-
-- size AVIF/WebP until re-uploaded.

ALTER TABLE public.product_media
  DROP COLUMN IF EXISTS avif_640_url,
  DROP COLUMN IF EXISTS webp_640_url,
  DROP COLUMN IF EXISTS avif_640_storage_path,
  DROP COLUMN IF EXISTS webp_640_storage_path,
  DROP COLUMN IF EXISTS avif_1200_url,
  DROP COLUMN IF EXISTS webp_1200_url,
  DROP COLUMN IF EXISTS avif_1200_storage_path,
  DROP COLUMN IF EXISTS webp_1200_storage_path;

ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS avif_480_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_480_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_480_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_480_storage_path TEXT,

  ADD COLUMN IF NOT EXISTS avif_750_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_750_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_750_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_750_storage_path TEXT,

  ADD COLUMN IF NOT EXISTS avif_1080_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_1080_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_1080_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_1080_storage_path TEXT,

  ADD COLUMN IF NOT EXISTS avif_1500_url TEXT,
  ADD COLUMN IF NOT EXISTS webp_1500_url TEXT,
  ADD COLUMN IF NOT EXISTS avif_1500_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS webp_1500_storage_path TEXT;
