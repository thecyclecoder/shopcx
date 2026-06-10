-- Operator-declared social promos / themes. The planner reads any active
-- campaign whose window contains a post's scheduled date and themes the
-- caption around its brief (and can lift the daily cap for the window).
-- This is how an admin tells the scheduler "we're running a July-4th promo."
-- See docs/brain/specs/automated-social-scheduler.md.

CREATE TABLE IF NOT EXISTS public.social_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  brief TEXT NOT NULL,                       -- angle / offer / CTA for caption theming

  emphasis_product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  boost_per_platform_per_day INTEGER,        -- optional: allow more posts/day during the promo

  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_campaigns_ws_window_idx
  ON public.social_campaigns (workspace_id, active, starts_on, ends_on);

ALTER TABLE public.social_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_campaigns_service_all ON public.social_campaigns;
CREATE POLICY social_campaigns_service_all ON public.social_campaigns
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS social_campaigns_select_own_workspace ON public.social_campaigns;
CREATE POLICY social_campaigns_select_own_workspace ON public.social_campaigns
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
