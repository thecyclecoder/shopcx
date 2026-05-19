-- cart_drafts.source_product_handle
--
-- The storefront PDP that originated a cart add. Used by the customize
-- page's "Keep shopping" link so we send the customer back to the same
-- product, not the homepage — keeps the funnel exclusive. Null on
-- legacy carts created before this column existed; client falls back
-- to hiding the link.

ALTER TABLE public.cart_drafts
  ADD COLUMN IF NOT EXISTS source_product_handle TEXT;
