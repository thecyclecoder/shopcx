-- Dedicated import job tracking (replaces sync_jobs for imports)
CREATE TABLE public.import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('subscriptions', 'customers', 'orders')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'splitting', 'processing', 'finalizing', 'completed', 'failed')),
  file_path TEXT NOT NULL,
  total_records INTEGER DEFAULT 0,
  processed_records INTEGER DEFAULT 0,
  failed_records INTEGER DEFAULT 0,
  total_chunks INTEGER DEFAULT 0,
  completed_chunks INTEGER DEFAULT 0,
  finalize_total INTEGER DEFAULT 0,
  finalize_completed INTEGER DEFAULT 0,
  error TEXT,
  failed_chunk_index INTEGER,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_import_jobs_workspace ON public.import_jobs(workspace_id);
CREATE INDEX idx_import_jobs_status ON public.import_jobs(workspace_id, status);

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view import jobs in their workspaces"
  ON public.import_jobs FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on import_jobs"
  ON public.import_jobs FOR ALL
  USING (auth.role() = 'service_role');
