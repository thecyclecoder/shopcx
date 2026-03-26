-- Phase 4: Knowledge Base tables

-- Knowledge base articles
CREATE TABLE public.knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('product', 'policy', 'shipping', 'billing', 'general')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_base_workspace ON public.knowledge_base(workspace_id, active, category);

ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view KB in their workspace" ON public.knowledge_base FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on KB" ON public.knowledge_base FOR ALL TO service_role USING (true) WITH CHECK (true);

-- KB chunks with embeddings for RAG
CREATE TABLE public.kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id UUID NOT NULL REFERENCES public.knowledge_base(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  embedding vector(1536),
  chunk_index INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kb_chunks_kb ON public.kb_chunks(kb_id);
CREATE INDEX idx_kb_chunks_workspace ON public.kb_chunks(workspace_id);

ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view KB chunks in their workspace" ON public.kb_chunks FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on KB chunks" ON public.kb_chunks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Semantic search RPC for KB chunks
CREATE OR REPLACE FUNCTION public.match_kb_chunks(
  query_embedding vector(1536),
  ws_id UUID,
  match_threshold FLOAT DEFAULT 0.65,
  match_count INT DEFAULT 10
)
RETURNS TABLE(id UUID, kb_id UUID, chunk_text TEXT, chunk_index INT, similarity FLOAT)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.kb_id,
    kc.chunk_text,
    kc.chunk_index,
    1 - (kc.embedding <=> query_embedding)::FLOAT AS similarity
  FROM public.kb_chunks kc
  JOIN public.knowledge_base kb ON kb.id = kc.kb_id
  WHERE kc.workspace_id = ws_id
    AND kb.active = true
    AND kc.embedding IS NOT NULL
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
