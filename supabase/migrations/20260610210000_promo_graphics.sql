-- Promo graphics: AI-generated sale creative (Nano Banana Pro) from a product's
-- isolated image, themed to the promo. See docs/brain/specs/automated-social-scheduler.md.

ALTER TABLE public.social_campaigns
  ADD COLUMN IF NOT EXISTS generated_media JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{post_type, ratio, url}]
  ADD COLUMN IF NOT EXISTS graphics_status TEXT NOT NULL DEFAULT 'none'
    CHECK (graphics_status IN ('none', 'generating', 'ready', 'failed'));

-- Allow promo-graphic posts in the scheduler.
ALTER TABLE public.scheduled_social_posts
  DROP CONSTRAINT IF EXISTS scheduled_social_posts_source_kind_check;
ALTER TABLE public.scheduled_social_posts
  ADD CONSTRAINT scheduled_social_posts_source_kind_check
  CHECK (source_kind IN ('avatar', 'ad_video', 'testimonial', 'resource', 'promo'));
