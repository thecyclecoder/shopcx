-- Track helpful votes on knowledge base articles
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS helpful_yes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS helpful_no INTEGER NOT NULL DEFAULT 0;
