-- Cache the workspace's accessible ad accounts once (at OAuth time
-- with ads_read scope) so we don't have to re-fetch /me/adaccounts
-- on every comment-ingest call. JSONB array of { id, name } objects.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS meta_ad_accounts JSONB;

-- Augment the per-post cache so we can store the result of the
-- "is this an ad?" lookup. When the JIT creative search finds a
-- hit, we cache the creative id + destination URL alongside the
-- existing matched_product_id so future comments on the same post
-- are answered without another Marketing API call.
ALTER TABLE public.meta_post_cache
  ADD COLUMN IF NOT EXISTS ad_creative_id TEXT,
  ADD COLUMN IF NOT EXISTS ad_destination_url TEXT;

COMMENT ON COLUMN public.meta_post_cache.ad_creative_id IS
  'Meta ad creative id discovered via Marketing API lookup (effective_object_story_id or effective_instagram_media_id match). Definitive signal that this post is an ad.';
COMMENT ON COLUMN public.meta_post_cache.ad_destination_url IS
  'Click-through URL pulled from the ad creative spec. Used for product matching even when the FB post body / attachments don''t expose it (common on IG ads).';
