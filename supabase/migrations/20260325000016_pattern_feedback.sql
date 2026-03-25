-- Track feedback when agents remove smart tags (for pattern improvement)
CREATE TABLE public.pattern_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  pattern_id UUID REFERENCES public.smart_patterns(id) ON DELETE SET NULL,
  tag_removed TEXT NOT NULL,
  agent_reason TEXT,
  ai_analysis JSONB,  -- Claude's analysis of whether to adjust the pattern
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'applied', 'dismissed')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pattern_feedback_workspace ON public.pattern_feedback(workspace_id, status);

ALTER TABLE public.pattern_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view feedback in their workspaces"
  ON public.pattern_feedback FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access on pattern_feedback"
  ON public.pattern_feedback FOR ALL
  USING (auth.role() = 'service_role');
