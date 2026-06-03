-- Ad tool — Phase 2: demographic-driven avatar proposals.
--
-- Before any photos are uploaded or characters minted on Higgsfield, the system
-- reads who actually buys each product (the four-field demographic tuple) and
-- proposes archetype briefs the operator confirms. This table is the proposal
-- queue. The proposal generator is a READ-ONLY consumer of the demographic
-- enrichment pipeline — it never writes to customer_demographics.
--
-- See docs/brain/specs/ad-tool.md Phase 2 + docs/brain/lifecycles/demographic-enrichment.md

CREATE TABLE IF NOT EXISTS public.ad_avatar_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  -- Full brief returned by Opus: { name, wardrobe, setting, hook_delivery_style,
  --   photoshoot_brief, ... }
  archetype_brief JSONB NOT NULL DEFAULT '{}',

  -- ONLY the four-field demographic tuple — no health_priorities, no buyer_type,
  -- no urban/geo fields (see spec Phase 2 "Fields we explicitly DO NOT use").
  -- { cohort_size, gender_share, age_range_share, life_stage_share,
  --   income_bracket_share, used_fallback_snapshot }
  demographic_basis JSONB NOT NULL DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'proposed',      -- proposed | confirmed | rejected | archived
  confirmed_avatar_id UUID REFERENCES public.ad_avatars(id) ON DELETE SET NULL,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_avatar_proposals_workspace_idx
  ON public.ad_avatar_proposals (workspace_id, product_id, status, created_at DESC);

ALTER TABLE public.ad_avatar_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ad_avatar_proposals_select_own_workspace" ON public.ad_avatar_proposals;
DROP POLICY IF EXISTS "ad_avatar_proposals_service_role_all" ON public.ad_avatar_proposals;

CREATE POLICY "ad_avatar_proposals_select_own_workspace" ON public.ad_avatar_proposals
  FOR SELECT
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "ad_avatar_proposals_service_role_all" ON public.ad_avatar_proposals
  FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');

-- Lineage: which proposal an avatar was built from (queryable later, e.g.
-- "show me avatars built for buyers of Mixed Berry Tabs").
ALTER TABLE public.ad_avatars
  ADD COLUMN IF NOT EXISTS proposed_from_id UUID REFERENCES public.ad_avatar_proposals(id) ON DELETE SET NULL;

-- ── Cohort query helper ─────────────────────────────────────────────────────
-- The proposal generator needs the unique customers who bought a product. Since
-- orders.line_items is JSONB with no product_id (Shopify is being sunset), we
-- title-match against li->>'title' — the canonical pattern from
-- docs/brain/lifecycles/demographic-enrichment.md "Querying the cohort behind a
-- product". SECURITY DEFINER so the service-role caller bypasses RLS cleanly.
CREATE OR REPLACE FUNCTION public.ad_product_cohort(p_workspace_id UUID, p_title_stem TEXT)
RETURNS TABLE(customer_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT o.customer_id
  FROM public.orders o, jsonb_array_elements(o.line_items) li
  WHERE o.workspace_id = p_workspace_id
    AND o.customer_id IS NOT NULL
    AND li->>'title' ILIKE '%' || p_title_stem || '%';
$$;
