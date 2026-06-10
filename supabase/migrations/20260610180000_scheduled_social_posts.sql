-- Automated organic social scheduler — the content calendar.
-- See docs/brain/specs/automated-social-scheduler.md.
--
-- One row = one planned/published organic post to a FB page or IG account.
-- The daily planner inserts rows out to a 7-day horizon; an Inngest function
-- publishes each at scheduled_at. Sources: campaign avatar images, finished ad
-- videos (reels), review/testimonial statics, and blog resources.

CREATE TABLE IF NOT EXISTS public.scheduled_social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Target account (a meta_pages row — facebook page OR instagram user).
  meta_page_id UUID NOT NULL REFERENCES public.meta_pages(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  post_type TEXT NOT NULL CHECK (post_type IN ('feed', 'reel', 'story')),

  -- Where the media came from.
  source_kind TEXT NOT NULL CHECK (source_kind IN ('avatar', 'ad_video', 'testimonial', 'resource')),
  source_ref_id UUID,                       -- campaign_id | ad_video_id | post_id
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,

  -- Media: private-bucket assets store bucket+path (re-signed at publish);
  -- public assets (resource images) store media_url directly.
  media_bucket TEXT,
  media_path TEXT,
  media_url TEXT,

  caption TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,

  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('draft', 'scheduled', 'publishing', 'posted', 'failed', 'skipped', 'cancelled')),
  published_platform_id TEXT,               -- FB post_id / IG media id
  published_permalink TEXT,
  published_at TIMESTAMPTZ,
  error TEXT,

  created_by TEXT NOT NULL DEFAULT 'system', -- 'system' | <workspace_member user_id>
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_social_posts_ws_sched_idx
  ON public.scheduled_social_posts (workspace_id, scheduled_at);
CREATE INDEX IF NOT EXISTS scheduled_social_posts_status_idx
  ON public.scheduled_social_posts (workspace_id, status, scheduled_at);
-- Resource-rotation lookups: "when did we last post this asset?"
CREATE INDEX IF NOT EXISTS scheduled_social_posts_source_idx
  ON public.scheduled_social_posts (workspace_id, source_kind, source_ref_id, scheduled_at);

ALTER TABLE public.scheduled_social_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_social_posts_service_all ON public.scheduled_social_posts;
CREATE POLICY scheduled_social_posts_service_all ON public.scheduled_social_posts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS scheduled_social_posts_select_own_workspace ON public.scheduled_social_posts;
CREATE POLICY scheduled_social_posts_select_own_workspace ON public.scheduled_social_posts
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

-- Scheduler config per workspace: enabled flag, weekly cadence per post type,
-- time slots, approval gate, target pages. Defaults encode the best-practice
-- cadence from the spec until the optimizer (Phase 5) takes over.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS social_scheduler_config JSONB NOT NULL DEFAULT '{
    "enabled": false,
    "require_approval": false,
    "timezone": "America/Chicago",
    "cadence": { "reel": 3, "feed": 4, "story": 7 },
    "time_slots": { "feed": ["10:00", "18:30"], "reel": ["12:00", "19:00"], "story": ["09:00", "17:00", "20:00"] },
    "min_resource_reuse_days": 21
  }'::jsonb;
