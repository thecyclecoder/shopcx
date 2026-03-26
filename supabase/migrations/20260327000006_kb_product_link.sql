-- Optional product link on knowledge base articles
-- Articles can be general or scoped to a specific product
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS product_shopify_id TEXT;
ALTER TABLE public.knowledge_base ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'gorgias', 'import'));

CREATE INDEX idx_knowledge_base_product ON public.knowledge_base(workspace_id, product_shopify_id) WHERE product_shopify_id IS NOT NULL;
