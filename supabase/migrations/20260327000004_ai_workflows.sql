-- Phase 4: AI Workflows (separate from smart tag workflows)

CREATE TABLE public.ai_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  trigger_intent TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,

  -- Recognition: what intents/patterns does this workflow handle?
  match_patterns TEXT[] DEFAULT '{}',
  match_categories TEXT[] DEFAULT '{}',

  -- Response source: macro or KB article
  response_source TEXT NOT NULL DEFAULT 'macro' CHECK (response_source IN ('macro', 'kb', 'either')),
  preferred_macro_id UUID REFERENCES public.macros(id) ON DELETE SET NULL,
  preferred_kb_ids UUID[] DEFAULT '{}',

  -- Actions the AI can take (scoped)
  allowed_actions JSONB NOT NULL DEFAULT '[]',

  -- After response: what workflow to trigger (links to existing workflows)
  post_response_workflow_id UUID REFERENCES public.workflows(id) ON DELETE SET NULL,

  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_workflows_workspace ON public.ai_workflows(workspace_id, enabled);
CREATE INDEX idx_ai_workflows_intent ON public.ai_workflows(workspace_id, trigger_intent);

ALTER TABLE public.ai_workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view AI workflows" ON public.ai_workflows FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on AI workflows" ON public.ai_workflows FOR ALL TO service_role USING (true) WITH CHECK (true);
