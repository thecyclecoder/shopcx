-- product_ad_angles meta-copy CHECK constraints were stale early guesses (primary_text <= 125,
-- description <= 30) that never tracked src/lib/ad-tool-config.ts META_CAPS (primary_text 600,
-- description 90 — the value every copy path clips to). Deterministic-mode copy was short enough to
-- fit the old caps, but Dahlia's author-mode copy (dahlia-copy-author) runs longer, so her
-- product_ad_angles insert was rejected on `product_ad_angles_meta_desc_cap` (and would also trip
-- the primary cap) — angleId came back null, the creative landed as a copy-LESS `draft` with no
-- copy_pack persisted and no ad_creative_copy_variants rows, and the ad detail page had no headline /
-- primary text to show (observed 2026-07-17 on the Amazing Coffee author test run). Widen both caps
-- to match META_CAPS so the DB and the code agree on one Meta-correct limit. Headline (40) already
-- matched, left as-is. Idempotent (DROP IF EXISTS + ADD); safe — every existing row is already within
-- the wider bounds, so no row is invalidated.

ALTER TABLE public.product_ad_angles
  DROP CONSTRAINT IF EXISTS product_ad_angles_meta_primary_cap;
ALTER TABLE public.product_ad_angles
  ADD CONSTRAINT product_ad_angles_meta_primary_cap
  CHECK (meta_primary_text IS NULL OR char_length(meta_primary_text) <= 600);

ALTER TABLE public.product_ad_angles
  DROP CONSTRAINT IF EXISTS product_ad_angles_meta_desc_cap;
ALTER TABLE public.product_ad_angles
  ADD CONSTRAINT product_ad_angles_meta_desc_cap
  CHECK (meta_description IS NULL OR char_length(meta_description) <= 90);
