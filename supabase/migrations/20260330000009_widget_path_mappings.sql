-- Widget path → article category mappings
CREATE TABLE public.widget_path_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'prefix' CHECK (match_type IN ('exact', 'prefix')),
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_widget_path_mappings_workspace ON public.widget_path_mappings(workspace_id);

ALTER TABLE public.widget_path_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view path mappings" ON public.widget_path_mappings FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on path mappings" ON public.widget_path_mappings FOR ALL TO service_role USING (true) WITH CHECK (true);
