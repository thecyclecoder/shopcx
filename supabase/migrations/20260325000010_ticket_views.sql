-- Saved ticket views (filtered views that appear in sidebar)
CREATE TABLE public.ticket_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  filters JSONB NOT NULL DEFAULT '{}',
  -- filters shape: { status?: string, channel?: string, assigned_to?: string, tag?: string }
  sort_order INTEGER DEFAULT 0,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_views_workspace ON public.ticket_views(workspace_id, sort_order);

ALTER TABLE public.ticket_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view ticket views in their workspaces"
  ON public.ticket_views FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on ticket_views"
  ON public.ticket_views FOR ALL
  USING (auth.role() = 'service_role');
