-- Track sync job progress for the frontend
CREATE TABLE public.sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('full', 'customers', 'orders')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  phase TEXT, -- 'customers', 'orders', 'finalizing'
  total_customers INTEGER DEFAULT 0,
  synced_customers INTEGER DEFAULT 0,
  total_orders INTEGER DEFAULT 0,
  synced_orders INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_jobs_workspace ON public.sync_jobs(workspace_id, created_at DESC);

-- RLS
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their sync jobs"
  ON public.sync_jobs FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM public.workspace_members wm WHERE wm.user_id = auth.uid())
  );

CREATE POLICY "Service role full access on sync_jobs"
  ON public.sync_jobs FOR ALL
  USING (auth.role() = 'service_role');
