-- Track when Haiku has reviewed a product review for typos/autocorrect
-- mistakes. Reviews where body_polished_at IS NULL AND body_locked_at
-- IS NULL get polished on the next sync. After polish, body_polished_at
-- is stamped so we don't re-process; body_locked_at is reserved for
-- human admin edits and still wins over the polish pipeline.

ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS body_polished_at TIMESTAMPTZ;

COMMENT ON COLUMN public.product_reviews.body_polished_at IS
  'Set when Haiku has cleaned obvious typos in body/smart_quote. NULL = needs polish on next sync. body_locked_at (manual edits) takes precedence.';
