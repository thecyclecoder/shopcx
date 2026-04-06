-- Product Intelligence: structured product knowledge from ShopGrowth or manual input
-- Used to audit KB articles and macros, and provide AI with deep product context

CREATE TABLE IF NOT EXISTS public.product_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                          -- Product name (from Shopify or manual)
  content TEXT NOT NULL DEFAULT '',              -- The full LLM export / intelligence blob
  source TEXT NOT NULL DEFAULT 'manual',         -- 'shopgrowth', 'manual', 'url_scrape'
  source_urls TEXT[] NOT NULL DEFAULT '{}',      -- URLs that were scraped and added
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id)              -- One intelligence per product per workspace
);

ALTER TABLE public.product_intelligence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_intelligence" ON public.product_intelligence FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full on product_intelligence" ON public.product_intelligence FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_product_intelligence_workspace ON public.product_intelligence (workspace_id);
CREATE INDEX idx_product_intelligence_product ON public.product_intelligence (product_id);
