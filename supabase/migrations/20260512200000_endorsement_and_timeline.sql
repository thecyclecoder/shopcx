-- Two new storefront sections: a per-product nutritionist endorsement
-- and a "What to expect" timeline. Both are part of the editable
-- page_content layer (versioned, regenerable) rather than separate
-- tables since they're 1-per-product and live alongside the rest of
-- the marketing copy.

ALTER TABLE product_page_content
  ADD COLUMN IF NOT EXISTS endorsement_name TEXT,
  ADD COLUMN IF NOT EXISTS endorsement_title TEXT,
  ADD COLUMN IF NOT EXISTS endorsement_quote TEXT,
  ADD COLUMN IF NOT EXISTS endorsement_bullets JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Array of { time_label, headline, body } — 3-6 milestones the
  -- customer should expect across their subscription. Helps pre-sell
  -- the recurring purchase by making the journey concrete.
  ADD COLUMN IF NOT EXISTS expectation_timeline JSONB NOT NULL DEFAULT '[]'::jsonb;
