-- Google integrations for SEO keyword research
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS google_ads_developer_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS google_ads_client_id TEXT,
  ADD COLUMN IF NOT EXISTS google_ads_client_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS google_ads_refresh_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS google_ads_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS google_search_console_credentials_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS google_search_console_site_url TEXT;

-- SEO keyword research per product
CREATE TABLE public.product_seo_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  monthly_searches INTEGER,
  competition TEXT CHECK (competition IN ('LOW', 'MEDIUM', 'HIGH', 'UNSPECIFIED')),
  competition_index NUMERIC,
  cpc_low_cents INTEGER,
  cpc_high_cents INTEGER,
  relevance TEXT CHECK (relevance IN ('primary', 'secondary', 'long_tail')),
  is_selected BOOLEAN DEFAULT false,
  source TEXT DEFAULT 'keyword_planner' CHECK (source IN ('keyword_planner', 'search_console', 'ai_suggested')),
  search_console_clicks INTEGER,
  search_console_impressions INTEGER,
  search_console_ctr NUMERIC,
  search_console_position NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, keyword)
);

CREATE INDEX idx_product_seo_keywords_product ON public.product_seo_keywords(product_id);
CREATE INDEX idx_product_seo_keywords_selected ON public.product_seo_keywords(product_id, is_selected) WHERE is_selected = true;

ALTER TABLE public.product_seo_keywords ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_seo_keywords" ON public.product_seo_keywords
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_seo_keywords" ON public.product_seo_keywords
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- SEO metadata per product (generated from selected keywords)
ALTER TABLE public.product_page_content
  ADD COLUMN IF NOT EXISTS seo_title TEXT,
  ADD COLUMN IF NOT EXISTS seo_description TEXT,
  ADD COLUMN IF NOT EXISTS seo_keywords TEXT[] DEFAULT '{}';
