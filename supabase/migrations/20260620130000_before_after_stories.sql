-- Up to TWO before/after transformation stories per PDP, each with its own
-- testimonial. The IMAGES live in product_media (slots before_1/after_1,
-- before_2/after_2 — re-hosted from the product's Shopify PDP, never hotlinked);
-- this column holds the matching testimonial text per story, mirroring how
-- `endorsements` pairs JSONB copy with `endorsement_N_avatar` media slots.
--
-- Shape — see src/app/(storefront)/_lib/page-data.ts BeforeAfterStory:
--   [
--     { "quote": "I lost 12 lbs and the bloating is gone.", "name": "Anne B.", "variant": "Peach Mango" },
--     { "quote": "...", "name": "...", "variant": null }
--   ]
-- Index 0 → before_1/after_1, index 1 → before_2/after_2. Legacy single-story
-- PDPs (Amazing Coffee: slots before/after) stay compatible — a story with no
-- entry here just renders the pair with no testimonial.

ALTER TABLE public.product_page_content
  ADD COLUMN IF NOT EXISTS before_after_stories JSONB NOT NULL DEFAULT '[]'::jsonb;
