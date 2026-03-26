-- RPC for semantic macro matching (same pattern as match_kb_chunks)
CREATE OR REPLACE FUNCTION public.match_macros(
  query_embedding vector(1536),
  ws_id UUID,
  match_threshold FLOAT DEFAULT 0.60,
  match_count INT DEFAULT 5
)
RETURNS TABLE(id UUID, name TEXT, body_text TEXT, body_html TEXT, category TEXT, similarity FLOAT)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.name,
    m.body_text,
    m.body_html,
    m.category,
    1 - (m.embedding <=> query_embedding)::FLOAT AS similarity
  FROM public.macros m
  WHERE m.workspace_id = ws_id
    AND m.active = true
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
