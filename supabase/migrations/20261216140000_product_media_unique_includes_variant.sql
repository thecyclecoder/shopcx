-- Make product_media's uniqueness variant-aware.
--
-- The existing constraint is UNIQUE (workspace_id, product_id, slot, display_order).
-- It predates variant scoping, so once per-variant assets exist (the review_hero,
-- one per flavour) the SECOND variant of a product collides with the first —
-- Amazing Coffee's Hazelnut row conflicted with its Cocoa row even though they
-- are different variants and different images.
--
-- Replaced with a unique INDEX that includes the variant, using a sentinel for
-- NULL. That detail matters: in Postgres NULLs are distinct in a unique index,
-- so a naive (…, variant_id) index would let unlimited duplicate PRODUCT-scoped
-- rows through and silently drop the guarantee the old constraint gave every
-- pre-existing slot (hero, press_*, ingredient_*, timeline_*). COALESCE to the
-- nil uuid collapses NULLs so they still conflict with each other.
--
-- Dropping a CONSTRAINT (not a table or column) — no data is touched.
-- -- reversible: recreates the same guarantee, widened by variant_id; no data loss

ALTER TABLE public.product_media
  DROP CONSTRAINT IF EXISTS product_media_workspace_product_slot_order_unique;

CREATE UNIQUE INDEX IF NOT EXISTS product_media_ws_product_variant_slot_order_unique
  ON public.product_media (
    workspace_id,
    product_id,
    COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slot,
    display_order
  );
