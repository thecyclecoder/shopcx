-- Template-based workflows triggered by smart tags
CREATE TABLE public.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template TEXT NOT NULL CHECK (template IN ('order_tracking', 'cancel_request', 'subscription_inquiry')),
  trigger_tag TEXT NOT NULL,
  enabled BOOLEAN DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_workspace ON public.workflows(workspace_id, enabled);
CREATE INDEX idx_workflows_trigger ON public.workflows(workspace_id, trigger_tag, enabled);

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view workflows in their workspaces"
  ON public.workflows FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on workflows"
  ON public.workflows FOR ALL
  USING (auth.role() = 'service_role');
