-- Macro audit job tracking for progress display
CREATE TABLE IF NOT EXISTS public.macro_audit_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_intelligence_id UUID NOT NULL REFERENCES public.product_intelligence(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  results JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.macro_audit_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read macro_audit_jobs" ON public.macro_audit_jobs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on macro_audit_jobs" ON public.macro_audit_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
