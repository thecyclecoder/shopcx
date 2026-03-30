-- Add cancel relevance tagging to product_reviews
-- AI analysis tags each review with which cancel reasons it helps counter

ALTER TABLE product_reviews
  ADD COLUMN IF NOT EXISTS cancel_relevance jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cancel_relevance_at timestamptz DEFAULT NULL;

COMMENT ON COLUMN product_reviews.cancel_relevance IS 'Array of cancel reason slugs this review helps counter, e.g. ["too_expensive", "not_seeing_results"]';
COMMENT ON COLUMN product_reviews.cancel_relevance_at IS 'When the cancel relevance analysis was last run';

-- Index for querying reviews by cancel relevance
CREATE INDEX IF NOT EXISTS idx_product_reviews_cancel_relevance
  ON product_reviews USING gin (cancel_relevance)
  WHERE cancel_relevance IS NOT NULL;
