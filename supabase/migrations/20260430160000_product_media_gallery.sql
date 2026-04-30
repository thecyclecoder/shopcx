-- Allow multiple product_media rows per (workspace, product, slot) so
-- the storefront hero (and any other slot that wants it) can be a
-- gallery instead of a single image. Existing rows become display_order=0.

ALTER TABLE public.product_media
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;

-- Drop the old single-image-per-slot constraint
ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_workspace_id_product_id_slot_key;

-- New uniqueness: one row per (ws, product, slot, display_order)
ALTER TABLE public.product_media
  ADD CONSTRAINT product_media_workspace_product_slot_order_unique
  UNIQUE (workspace_id, product_id, slot, display_order);

-- Index for ordered fetches
CREATE INDEX IF NOT EXISTS idx_product_media_slot_order
  ON public.product_media(workspace_id, product_id, slot, display_order);
