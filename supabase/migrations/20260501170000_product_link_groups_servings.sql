-- Phase 1: linked products + variant-level servings
-- ----------------------------------------------------
-- Storefront PDPs can render a "format" toggle (e.g. Instant ↔ K-Cups)
-- by linking related products into a "link group". On either page, the
-- toggle lets the customer swap inline without leaving — pricing stays
-- the same, hero image swaps, servings chip updates, and the
-- add-to-cart variant points at the linked product's variant.

-- 1. Variant servings + servings_unit
-- Source of truth in Shopify is product-level (custom.servings,
-- custom.servings_unit). On sync we fan it out to every variant of
-- the product so future per-pack overrides + price-per-serving math
-- can live entirely on the variant.
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS servings INTEGER,
  ADD COLUMN IF NOT EXISTS servings_unit TEXT;

-- 2. Link group header — one row per "what makes these link"
CREATE TABLE IF NOT EXISTS public.product_link_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,    -- "format" to start; could be "size", "flavor", etc.
  name TEXT NOT NULL,         -- display label shown in the toggle, e.g. "Coffee Format"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_link_groups_workspace
  ON public.product_link_groups(workspace_id);

-- 3. Link group members — which products are in this group + their value
CREATE TABLE IF NOT EXISTS public.product_link_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.product_link_groups(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  value TEXT NOT NULL,                    -- this product's value in the group, e.g. "Instant", "K-Cups"
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_link_members_product
  ON public.product_link_members(product_id);
CREATE INDEX IF NOT EXISTS idx_product_link_members_group_order
  ON public.product_link_members(group_id, display_order);

-- 4. RLS
ALTER TABLE public.product_link_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_link_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read product_link_groups" ON public.product_link_groups;
CREATE POLICY "Authenticated read product_link_groups"
  ON public.product_link_groups FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Public read product_link_groups" ON public.product_link_groups;
CREATE POLICY "Public read product_link_groups"
  ON public.product_link_groups FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Service role full on product_link_groups" ON public.product_link_groups;
CREATE POLICY "Service role full on product_link_groups"
  ON public.product_link_groups FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read product_link_members" ON public.product_link_members;
CREATE POLICY "Authenticated read product_link_members"
  ON public.product_link_members FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Public read product_link_members" ON public.product_link_members;
CREATE POLICY "Public read product_link_members"
  ON public.product_link_members FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Service role full on product_link_members" ON public.product_link_members;
CREATE POLICY "Service role full on product_link_members"
  ON public.product_link_members FOR ALL TO service_role USING (true) WITH CHECK (true);
