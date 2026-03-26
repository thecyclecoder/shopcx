-- Phase 4: AI fields on tickets + knowledge gaps

-- AI draft fields on tickets
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_draft TEXT;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_confidence FLOAT;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_tier TEXT CHECK (ai_tier IN ('auto', 'review', 'human'));
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_source_type TEXT CHECK (ai_source_type IN ('macro', 'kb'));
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_source_id UUID;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_workflow_id UUID REFERENCES public.ai_workflows(id) ON DELETE SET NULL;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_drafted_at TIMESTAMPTZ;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_handled BOOLEAN DEFAULT false;

-- Knowledge gaps (nightly analysis)
CREATE TABLE public.knowledge_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  sample_ticket_ids UUID[] DEFAULT '{}',
  suggested_title TEXT,
  suggested_content TEXT,
  suggested_category TEXT CHECK (suggested_category IN ('product', 'policy', 'shipping', 'billing', 'general')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed', 'created')),
  created_kb_id UUID REFERENCES public.knowledge_base(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_gaps_workspace ON public.knowledge_gaps(workspace_id, status);

ALTER TABLE public.knowledge_gaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view knowledge gaps" ON public.knowledge_gaps FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on knowledge gaps" ON public.knowledge_gaps FOR ALL TO service_role USING (true) WITH CHECK (true);
