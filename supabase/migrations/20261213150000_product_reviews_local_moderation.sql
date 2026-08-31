-- Local moderation state for product_reviews (klaviyo-sunset, Phase A).
--
-- Review moderation used to round-trip to Klaviyo: the dashboard PATCHed
-- `/reviews/{id}/` and Klaviyo held the rejection reason + explanation the
-- moderator picked. The Klaviyo subscription is cancelled, so moderation is
-- now local-only and `product_reviews` is the sole system of record for it.
--
-- Without these columns the moderator's stated reason for rejecting a review
-- would be silently dropped on every reject — the dashboard collects it today
-- and Klaviyo was the only place it landed.
--
-- Additive + idempotent: three nullable columns, no backfill. Rows rejected
-- before the sunset keep `rejection_reason IS NULL` (their reason lives only in
-- Klaviyo and is not worth an export for 1,327 historical rows).

ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejection_explanation text,
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz;

COMMENT ON COLUMN public.product_reviews.rejection_reason IS
  'Why a moderator rejected this review (profanity_or_inappropriate | private_information | unrelated | false_or_misleading | fake | other). Local since the Klaviyo sunset; NULL for pre-sunset rejections.';
COMMENT ON COLUMN public.product_reviews.rejection_explanation IS
  'Free-text explanation a moderator typed alongside rejection_reason. NULL for pre-sunset rejections.';
COMMENT ON COLUMN public.product_reviews.moderated_at IS
  'Last time a human moderation action (publish/reject/feature/unfeature/type change) was applied to this row.';
