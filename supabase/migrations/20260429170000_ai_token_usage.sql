-- AI token usage log — per-call tracking of model, input/output tokens,
-- and the ticket the call was made on (when applicable). Drives the
-- per-ticket cost column + token-burn analysis on the AI analytics
-- dashboard.

CREATE TABLE IF NOT EXISTS public.ai_token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Cache tokens are billed at a fraction of input rate; track for accuracy
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  -- Free-form purpose tag so we can split orchestrator vs classify vs
  -- positive-close vs nightly-analysis in analytics
  purpose TEXT,
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_token_usage_ws_created ON public.ai_token_usage(workspace_id, created_at DESC);
CREATE INDEX idx_ai_token_usage_ticket ON public.ai_token_usage(ticket_id) WHERE ticket_id IS NOT NULL;

ALTER TABLE public.ai_token_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on ai_token_usage" ON public.ai_token_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members can read ai_token_usage" ON public.ai_token_usage
  FOR SELECT TO authenticated USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );
