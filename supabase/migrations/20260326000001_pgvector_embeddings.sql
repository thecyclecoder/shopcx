-- Enable pgvector and AI extensions
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Add embedding column to smart_patterns for semantic similarity matching
ALTER TABLE public.smart_patterns ADD COLUMN IF NOT EXISTS embedding vector(384);
ALTER TABLE public.smart_patterns ADD COLUMN IF NOT EXISTS embedding_text TEXT;

-- Add confidence tracking to pattern matches
ALTER TABLE public.smart_patterns ADD COLUMN IF NOT EXISTS description TEXT;

-- Create similarity search function
CREATE OR REPLACE FUNCTION public.match_pattern_embeddings(
  query_embedding vector(384),
  ws_id UUID,
  match_threshold FLOAT DEFAULT 0.65,
  match_count INT DEFAULT 3
)
RETURNS TABLE(
  id UUID,
  category TEXT,
  name TEXT,
  auto_tag TEXT,
  auto_action TEXT,
  similarity FLOAT
)
LANGUAGE sql
AS $$
  SELECT
    sp.id,
    sp.category,
    sp.name,
    sp.auto_tag,
    sp.auto_action,
    1 - (sp.embedding <=> query_embedding) as similarity
  FROM public.smart_patterns sp
  WHERE sp.embedding IS NOT NULL
    AND sp.active = true
    AND (sp.workspace_id IS NULL OR sp.workspace_id = ws_id)
    AND 1 - (sp.embedding <=> query_embedding) > match_threshold
  ORDER BY sp.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Index for fast vector search
CREATE INDEX IF NOT EXISTS idx_smart_patterns_embedding ON public.smart_patterns
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
