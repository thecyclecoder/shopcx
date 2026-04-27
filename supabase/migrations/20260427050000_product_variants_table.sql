-- Promote variants from a JSONB blob on products → first-class table with
-- UUIDs. This unblocks the Shopify deprecation: every variant now has a
-- stable internal id that survives the move to Braintree.
--
-- The existing products.variants JSONB column is kept (data is also mirrored
-- there) so legacy readers don't break. A separate backfill script
-- (scripts/backfill-product-variants.ts) populates the new table from the
-- existing JSONB and stamps internal_id back into each JSONB element.

CREATE TABLE IF NOT EXISTS public.product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,

  -- Optional: variants we eventually create directly (post-Shopify) won't
  -- have this. Unique within a workspace when present.
  shopify_variant_id TEXT,

  sku TEXT,
  title TEXT,
  option1 TEXT,
  option2 TEXT,
  option3 TEXT,

  price_cents INTEGER NOT NULL DEFAULT 0,
  compare_at_price_cents INTEGER,

  image_url TEXT,
  weight NUMERIC,
  weight_unit TEXT,

  position INTEGER NOT NULL DEFAULT 0,
  inventory_quantity INTEGER,
  available BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product
  ON public.product_variants(product_id, position);

CREATE INDEX IF NOT EXISTS idx_product_variants_workspace
  ON public.product_variants(workspace_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_sku
  ON public.product_variants(workspace_id, sku) WHERE sku IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_shopify
  ON public.product_variants(workspace_id, shopify_variant_id)
  WHERE shopify_variant_id IS NOT NULL;

ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read product_variants" ON public.product_variants;
CREATE POLICY "Authenticated read product_variants"
  ON public.product_variants FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "Service role full on product_variants" ON public.product_variants;
CREATE POLICY "Service role full on product_variants"
  ON public.product_variants FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read product_variants" ON public.product_variants;
CREATE POLICY "Public read product_variants"
  ON public.product_variants FOR SELECT TO anon USING (true);
