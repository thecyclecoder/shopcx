-- Playbook simulation results storage
CREATE TABLE IF NOT EXISTS public.playbook_simulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  playbook_id UUID NOT NULL REFERENCES public.playbooks(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL,
  customer_name TEXT,
  customer_email TEXT,
  message TEXT NOT NULL,
  sentiment TEXT NOT NULL DEFAULT 'neutral',
  result JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.playbook_simulations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read playbook_simulations" ON public.playbook_simulations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on playbook_simulations" ON public.playbook_simulations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_playbook_simulations_workspace ON public.playbook_simulations (workspace_id, created_at DESC);
