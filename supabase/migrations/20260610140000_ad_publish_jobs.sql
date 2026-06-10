-- Ad tool — Meta ad publish jobs. One row per "publish this campaign's video to
-- Meta" action: the chosen ad account / campaign / ad set / page, the generated
-- copy + CTA + destination, and the resulting Meta video/creative/ad ids. The
-- Inngest publisher (ad-tool/publish-to-meta) drives status. See
-- docs/brain/lifecycles/ad-publish.md.

CREATE TABLE IF NOT EXISTS public.ad_publish_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  video_id UUID REFERENCES public.ad_videos(id) ON DELETE SET NULL,

  -- Meta targets (bare ids; client adds act_ prefix).
  meta_account_id TEXT NOT NULL,
  meta_campaign_id TEXT,
  meta_adset_id TEXT NOT NULL,
  meta_page_id TEXT NOT NULL,            -- operator-selected page for the creative
  meta_instagram_user_id TEXT,           -- the page's linked IG account

  -- Copy (headline + variations / primary text + variations).
  headlines JSONB NOT NULL DEFAULT '[]',
  primary_texts JSONB NOT NULL DEFAULT '[]',
  description TEXT,
  cta_type TEXT NOT NULL DEFAULT 'SHOP_NOW',
  destination_url TEXT NOT NULL,
  publish_active BOOLEAN NOT NULL DEFAULT false,  -- false = create PAUSED

  -- Results.
  publish_status TEXT NOT NULL DEFAULT 'queued',  -- queued | uploading | creating | published | failed
  meta_video_id TEXT,
  meta_creative_id TEXT,
  meta_ad_id TEXT,
  error TEXT,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_publish_jobs_campaign_idx ON public.ad_publish_jobs (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ad_publish_jobs_workspace_idx ON public.ad_publish_jobs (workspace_id, publish_status, created_at DESC);

-- RLS — workspace-member SELECT, service-role write (matches the schema pattern).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.ad_publish_jobs ENABLE ROW LEVEL SECURITY';
  DROP POLICY IF EXISTS "ad_publish_jobs_select_own_workspace" ON public.ad_publish_jobs;
  DROP POLICY IF EXISTS "ad_publish_jobs_service_role_all" ON public.ad_publish_jobs;
  EXECUTE $f$
    CREATE POLICY "ad_publish_jobs_select_own_workspace" ON public.ad_publish_jobs
      FOR SELECT USING (
        workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
      )$f$;
  EXECUTE $f$
    CREATE POLICY "ad_publish_jobs_service_role_all" ON public.ad_publish_jobs
      FOR ALL USING (auth.jwt()->>'role' = 'service_role')
      WITH CHECK (auth.jwt()->>'role' = 'service_role')$f$;
END $$;
