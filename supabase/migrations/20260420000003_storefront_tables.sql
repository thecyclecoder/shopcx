-- Phase 2 — Storefront landing pages
-- Adds pricing tiers, how-it-works steps, benefit angles, storefront domain/slug
-- on workspaces, and anon SELECT policies on all tables the edge-cached
-- storefront needs to read.

-- ──────────────────────────────────────────────────────────────────────
-- product_pricing_tiers
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_pricing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  tier_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER NOT NULL,
  subscribe_price_cents INTEGER,
  subscribe_discount_pct INTEGER DEFAULT 25,
  per_unit_cents INTEGER,
  badge TEXT,
  is_highlighted BOOLEAN DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_product_pricing_tiers_product
  ON public.product_pricing_tiers(product_id, display_order);

ALTER TABLE public.product_pricing_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read product_pricing_tiers" ON public.product_pricing_tiers;
CREATE POLICY "Authenticated read product_pricing_tiers" ON public.product_pricing_tiers
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on product_pricing_tiers" ON public.product_pricing_tiers;
CREATE POLICY "Service role full on product_pricing_tiers" ON public.product_pricing_tiers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read product_pricing_tiers" ON public.product_pricing_tiers;
CREATE POLICY "Public read product_pricing_tiers" ON public.product_pricing_tiers
  FOR SELECT TO anon USING (true);

-- ──────────────────────────────────────────────────────────────────────
-- product_how_it_works
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_how_it_works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  icon_hint TEXT,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_how_it_works_product
  ON public.product_how_it_works(product_id, display_order);

ALTER TABLE public.product_how_it_works ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read product_how_it_works" ON public.product_how_it_works;
CREATE POLICY "Authenticated read product_how_it_works" ON public.product_how_it_works
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on product_how_it_works" ON public.product_how_it_works;
CREATE POLICY "Service role full on product_how_it_works" ON public.product_how_it_works
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read product_how_it_works" ON public.product_how_it_works;
CREATE POLICY "Public read product_how_it_works" ON public.product_how_it_works
  FOR SELECT TO anon USING (true);

-- ──────────────────────────────────────────────────────────────────────
-- product_benefit_angles (seeded for Phase 2b — storefront reads but
-- nothing populates them yet)
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_benefit_angles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  benefit_key TEXT NOT NULL,
  hero_headline TEXT,
  hero_subheadline TEXT,
  featured_ingredient_ids UUID[] DEFAULT '{}',
  lead_review_keywords TEXT[] DEFAULT '{}',
  comparison_row_order INTEGER[] DEFAULT '{}',
  faq_priority_ids UUID[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, benefit_key)
);

CREATE INDEX IF NOT EXISTS idx_product_benefit_angles_product
  ON public.product_benefit_angles(product_id, display_order);

ALTER TABLE public.product_benefit_angles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read product_benefit_angles" ON public.product_benefit_angles;
CREATE POLICY "Authenticated read product_benefit_angles" ON public.product_benefit_angles
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on product_benefit_angles" ON public.product_benefit_angles;
CREATE POLICY "Service role full on product_benefit_angles" ON public.product_benefit_angles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read product_benefit_angles" ON public.product_benefit_angles;
CREATE POLICY "Public read product_benefit_angles" ON public.product_benefit_angles
  FOR SELECT TO anon USING (true);

-- ──────────────────────────────────────────────────────────────────────
-- Storefront columns on workspaces
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS storefront_domain TEXT,
  ADD COLUMN IF NOT EXISTS storefront_slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_storefront_slug
  ON public.workspaces(storefront_slug) WHERE storefront_slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_storefront_domain
  ON public.workspaces(lower(storefront_domain)) WHERE storefront_domain IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- Anon read policies for storefront SSG
-- Storefront pages are publicly accessible — the build and ISR use the
-- service role, but we also allow anon reads so edge-rendered pages can
-- read at request time if needed. Only published content.
-- ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public read products" ON public.products;
CREATE POLICY "Public read products" ON public.products
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public read product_page_content" ON public.product_page_content;
CREATE POLICY "Public read product_page_content" ON public.product_page_content
  FOR SELECT TO anon USING (status = 'published');

DROP POLICY IF EXISTS "Public read product_ingredients" ON public.product_ingredients;
CREATE POLICY "Public read product_ingredients" ON public.product_ingredients
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public read product_ingredient_research" ON public.product_ingredient_research;
CREATE POLICY "Public read product_ingredient_research" ON public.product_ingredient_research
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public read product_benefit_selections" ON public.product_benefit_selections;
CREATE POLICY "Public read product_benefit_selections" ON public.product_benefit_selections
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public read product_review_analysis" ON public.product_review_analysis;
CREATE POLICY "Public read product_review_analysis" ON public.product_review_analysis
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public read product_reviews" ON public.product_reviews;
CREATE POLICY "Public read product_reviews" ON public.product_reviews
  FOR SELECT TO anon USING (status IN ('published', 'featured'));

DROP POLICY IF EXISTS "Public read product_media" ON public.product_media;
CREATE POLICY "Public read product_media" ON public.product_media
  FOR SELECT TO anon USING (true);
