-- Channel scoping for journeys and AI workflows
ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS channels TEXT[] DEFAULT '{}';
ALTER TABLE public.ai_workflows ADD COLUMN IF NOT EXISTS channels TEXT[] DEFAULT '{}';

-- Chat journeys table — deterministic step-by-step flows with forms
CREATE TABLE public.chat_journeys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_intent TEXT NOT NULL,
  match_patterns TEXT[] DEFAULT '{}',
  channels TEXT[] NOT NULL DEFAULT '{chat}',
  enabled BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 0,
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_journeys_workspace ON public.chat_journeys(workspace_id, enabled);
ALTER TABLE public.chat_journeys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view chat journeys" ON public.chat_journeys FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on chat_journeys" ON public.chat_journeys FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Track journey progress per ticket
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS journey_id UUID REFERENCES public.chat_journeys(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS journey_step INTEGER DEFAULT 0;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS journey_data JSONB DEFAULT '{}';
