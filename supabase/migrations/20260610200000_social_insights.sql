-- Social scheduler Phase 5 — engagement insights + the timing optimizer's data.
-- See docs/brain/specs/automated-social-scheduler.md.

-- Per-post engagement, pulled from Meta Insights after publishing.
ALTER TABLE public.scheduled_social_posts
  ADD COLUMN IF NOT EXISTS reach INTEGER,
  ADD COLUMN IF NOT EXISTS likes INTEGER,
  ADD COLUMN IF NOT EXISTS comments INTEGER,
  ADD COLUMN IF NOT EXISTS saves INTEGER,
  ADD COLUMN IF NOT EXISTS shares INTEGER,
  ADD COLUMN IF NOT EXISTS engagement INTEGER,          -- likes+comments+saves+shares
  ADD COLUMN IF NOT EXISTS metrics_synced_at TIMESTAMPTZ;

-- Audience-online heatmap per page: how active this account's followers are by
-- hour of day (0-23). Feeds the timing optimizer's "post when they're online".
CREATE TABLE IF NOT EXISTS public.social_audience_hours (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meta_page_id UUID NOT NULL REFERENCES public.meta_pages(id) ON DELETE CASCADE,
  hour SMALLINT NOT NULL CHECK (hour >= 0 AND hour <= 23),
  score NUMERIC NOT NULL DEFAULT 0,                     -- relative follower activity, 0..1
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meta_page_id, hour)
);

ALTER TABLE public.social_audience_hours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_audience_hours_service_all ON public.social_audience_hours;
CREATE POLICY social_audience_hours_service_all ON public.social_audience_hours
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS social_audience_hours_select_own_workspace ON public.social_audience_hours;
CREATE POLICY social_audience_hours_select_own_workspace ON public.social_audience_hours
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
