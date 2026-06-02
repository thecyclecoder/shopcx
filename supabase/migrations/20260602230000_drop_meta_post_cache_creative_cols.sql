-- 20260602210000 added ad_creative_id + ad_destination_url for a JIT
-- Marketing-API lookup. That approach turned out to be unsupported:
-- /adcreatives doesn't accept EQUAL filtering on
-- effective_object_story_id / effective_instagram_media_id, so we
-- can't do a targeted per-post lookup. Ad classification is handled
-- by the is_published=false / promotion_status / webhook ad_id
-- cascade instead. Drop the unused columns.
ALTER TABLE public.meta_post_cache
  DROP COLUMN IF EXISTS ad_creative_id,
  DROP COLUMN IF EXISTS ad_destination_url;
