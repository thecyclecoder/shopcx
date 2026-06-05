-- Ad tool — remember each segment's input image so a clip can be regenerated
-- (e.g. "redo this b-roll in higher-quality Veo 3, not Fast") without re-deriving
-- the source. B-roll = the product-media still it animates; talking-head re-uses
-- the campaign hero, so source_url is mainly for b-roll. Stable URL (product
-- media CDN), not a signed ad-tool URL.
ALTER TABLE public.ad_segments
  ADD COLUMN IF NOT EXISTS source_url TEXT;
