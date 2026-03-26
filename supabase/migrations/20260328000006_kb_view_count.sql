-- Track article views for "Most Viewed" on help center
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
