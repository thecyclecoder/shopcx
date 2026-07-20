-- ad_videos.format — add the right-column (1:1) format to the allowed set
-- (dahlia-produces-3-placement-multi-copy-creative-pack Phase 1).
--
-- Today `format` is a plain TEXT column with default `reels_9x16` and a comment
-- listing the allowed set (`reels_9x16 | feed_4x5 | stories_9x16`). No CHECK
-- constraint exists, so the "allowed set" is documented on the column comment +
-- the brain page (docs/brain/tables/ad_videos.md). To hold a right-column static
-- as a `format_variant_of_id` sibling of the canonical (feed) row, we add
-- `right_column_1x1` — lowercase, matching the existing enum discipline.
--
-- Idempotent: COMMENT ON COLUMN just replaces the comment. No backfill (new
-- creatives populate the value; legacy rows retain their existing format).
COMMENT ON COLUMN public.ad_videos.format IS
  'One rendered output per format. Allowed: reels_9x16 | feed_4x5 | stories_9x16 | right_column_1x1. Siblings link to the canonical row via format_variant_of_id. Lowercase.';
