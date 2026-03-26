-- Public URL fields for Knowledge Base articles
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT false;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS content_html TEXT;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS excerpt TEXT;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_slug ON public.knowledge_base(workspace_id, slug) WHERE slug IS NOT NULL;

-- Help center URL setting on workspace
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS help_center_url TEXT;

-- Drop the old category constraint and allow any category
ALTER TABLE public.knowledge_base DROP CONSTRAINT IF EXISTS knowledge_base_category_check;
