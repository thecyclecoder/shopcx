-- Sonnet orchestrator prompts — database-driven, per-workspace
-- Allows admins to train Sonnet without code changes

CREATE TABLE IF NOT EXISTS public.sonnet_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('rule', 'approach', 'tool_hint', 'personality', 'knowledge')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sonnet_prompts_workspace ON public.sonnet_prompts(workspace_id, category, enabled);

-- RLS
ALTER TABLE public.sonnet_prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Workspace members can read sonnet_prompts" ON public.sonnet_prompts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access on sonnet_prompts" ON public.sonnet_prompts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
