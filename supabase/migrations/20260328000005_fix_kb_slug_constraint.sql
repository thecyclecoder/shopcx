-- Fix: partial unique index doesn't work with ON CONFLICT
-- Replace with a proper unique constraint
DROP INDEX IF EXISTS idx_kb_slug;
ALTER TABLE public.knowledge_base ADD CONSTRAINT knowledge_base_workspace_slug_unique UNIQUE (workspace_id, slug);
