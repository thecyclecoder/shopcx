-- Phase 4: Macros (saved responses)

CREATE TABLE public.macros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  category TEXT CHECK (category IN ('product', 'policy', 'shipping', 'billing', 'subscription', 'general')),
  tags TEXT[] DEFAULT '{}',
  variables TEXT[] DEFAULT '{}',
  actions JSONB DEFAULT '[]',
  gorgias_id INTEGER,
  active BOOLEAN NOT NULL DEFAULT true,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_macros_workspace ON public.macros(workspace_id, active);
CREATE INDEX idx_macros_category ON public.macros(workspace_id, category);
CREATE UNIQUE INDEX idx_macros_gorgias ON public.macros(workspace_id, gorgias_id) WHERE gorgias_id IS NOT NULL;

ALTER TABLE public.macros ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view macros in their workspace" ON public.macros FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on macros" ON public.macros FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Embedding for macro matching (1536-dim like KB)
ALTER TABLE public.macros ADD COLUMN embedding vector(1536);
ALTER TABLE public.macros ADD COLUMN embedding_text TEXT;
