-- Product Intelligence Engine — Phase 1
-- Adds 5-stage pipeline: ingredients, ingredient research, review analysis, benefit selections, page content.

-- 1a. Extend products
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS target_customer TEXT,
  ADD COLUMN IF NOT EXISTS certifications TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS intelligence_status TEXT DEFAULT 'none'
    CHECK (intelligence_status IN ('none', 'ingredients_added', 'researching', 'research_complete', 'analyzing_reviews', 'reviews_complete', 'benefits_selected', 'generating_content', 'content_generated', 'published'));

-- 1b. product_ingredients
CREATE TABLE IF NOT EXISTS public.product_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dosage_mg NUMERIC,
  dosage_display TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, name)
);

CREATE INDEX IF NOT EXISTS idx_product_ingredients_product ON public.product_ingredients(product_id, display_order);

ALTER TABLE public.product_ingredients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read product_ingredients" ON public.product_ingredients;
CREATE POLICY "Authenticated read product_ingredients" ON public.product_ingredients
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Service role full on product_ingredients" ON public.product_ingredients;
CREATE POLICY "Service role full on product_ingredients" ON public.product_ingredients
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1c. product_ingredient_research
CREATE TABLE IF NOT EXISTS public.product_ingredient_research (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES public.product_ingredients(id) ON DELETE CASCADE,
  benefit_headline TEXT NOT NULL,
  mechanism_explanation TEXT NOT NULL,
  clinically_studied_benefits TEXT[] DEFAULT '{}',
  dosage_comparison TEXT,
  citations JSONB DEFAULT '[]',
  contraindications TEXT,
  ai_confidence NUMERIC NOT NULL DEFAULT 0.5 CHECK (ai_confidence >= 0 AND ai_confidence <= 1.0),
  raw_ai_response JSONB,
  researched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ingredient_id, benefit_headline)
);

CREATE INDEX IF NOT EXISTS idx_ingredient_research_product ON public.product_ingredient_research(product_id);
CREATE INDEX IF NOT EXISTS idx_ingredient_research_ingredient ON public.product_ingredient_research(ingredient_id);

ALTER TABLE public.product_ingredient_research ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read product_ingredient_research" ON public.product_ingredient_research;
CREATE POLICY "Authenticated read product_ingredient_research" ON public.product_ingredient_research
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Service role full on product_ingredient_research" ON public.product_ingredient_research;
CREATE POLICY "Service role full on product_ingredient_research" ON public.product_ingredient_research
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1d. product_review_analysis
CREATE TABLE IF NOT EXISTS public.product_review_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  top_benefits JSONB NOT NULL DEFAULT '[]',
  before_after_pain_points JSONB DEFAULT '[]',
  skeptic_conversions JSONB DEFAULT '[]',
  surprise_benefits JSONB DEFAULT '[]',
  most_powerful_phrases JSONB DEFAULT '[]',
  reviews_analyzed_count INTEGER NOT NULL DEFAULT 0,
  raw_ai_response JSONB,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id)
);

ALTER TABLE public.product_review_analysis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read product_review_analysis" ON public.product_review_analysis;
CREATE POLICY "Authenticated read product_review_analysis" ON public.product_review_analysis
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Service role full on product_review_analysis" ON public.product_review_analysis;
CREATE POLICY "Service role full on product_review_analysis" ON public.product_review_analysis
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1e. product_benefit_selections
CREATE TABLE IF NOT EXISTS public.product_benefit_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  benefit_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lead', 'supporting', 'skip')),
  display_order INTEGER NOT NULL DEFAULT 0,
  science_confirmed BOOLEAN NOT NULL DEFAULT false,
  customer_confirmed BOOLEAN NOT NULL DEFAULT false,
  customer_phrases TEXT[] DEFAULT '{}',
  customer_review_ids UUID[] DEFAULT '{}',
  ingredient_research_ids UUID[] DEFAULT '{}',
  ai_confidence NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, benefit_name)
);

CREATE INDEX IF NOT EXISTS idx_benefit_selections_product ON public.product_benefit_selections(product_id, role, display_order);

ALTER TABLE public.product_benefit_selections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read product_benefit_selections" ON public.product_benefit_selections;
CREATE POLICY "Authenticated read product_benefit_selections" ON public.product_benefit_selections
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Service role full on product_benefit_selections" ON public.product_benefit_selections;
CREATE POLICY "Service role full on product_benefit_selections" ON public.product_benefit_selections
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1f. product_page_content
CREATE TABLE IF NOT EXISTS public.product_page_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  hero_headline TEXT,
  hero_subheadline TEXT,
  benefit_bar JSONB DEFAULT '[]',
  mechanism_copy TEXT,
  ingredient_cards JSONB DEFAULT '[]',
  comparison_table_rows JSONB DEFAULT '[]',
  faq_items JSONB DEFAULT '[]',
  guarantee_copy TEXT,
  fda_disclaimer TEXT NOT NULL DEFAULT 'These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.',
  knowledge_base_article TEXT,
  kb_what_it_doesnt_do TEXT,
  support_macros JSONB DEFAULT '[]',
  raw_ai_response JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, version)
);

CREATE INDEX IF NOT EXISTS idx_page_content_product ON public.product_page_content(product_id, version DESC);

ALTER TABLE public.product_page_content ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read product_page_content" ON public.product_page_content;
CREATE POLICY "Authenticated read product_page_content" ON public.product_page_content
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Service role full on product_page_content" ON public.product_page_content;
CREATE POLICY "Service role full on product_page_content" ON public.product_page_content
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1g. product_media
CREATE TABLE IF NOT EXISTS public.product_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  url TEXT,
  storage_path TEXT,
  alt_text TEXT DEFAULT '',
  width INTEGER,
  height INTEGER,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_product_media_product ON public.product_media(product_id);

ALTER TABLE public.product_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read product_media" ON public.product_media;
CREATE POLICY "Authenticated read product_media" ON public.product_media
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "Service role full on product_media" ON public.product_media;
CREATE POLICY "Service role full on product_media" ON public.product_media
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 1h. Storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('product-media', 'product-media', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated users can upload product media" ON storage.objects;
CREATE POLICY "Authenticated users can upload product media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-media');

DROP POLICY IF EXISTS "Public read product media" ON storage.objects;
CREATE POLICY "Public read product media"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'product-media');

DROP POLICY IF EXISTS "Authenticated users can update product media" ON storage.objects;
CREATE POLICY "Authenticated users can update product media"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'product-media');

DROP POLICY IF EXISTS "Authenticated users can delete product media" ON storage.objects;
CREATE POLICY "Authenticated users can delete product media"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'product-media');
