-- Pricing Rules
CREATE TABLE public.pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  quantity_breaks JSONB NOT NULL DEFAULT '[]',
  free_shipping BOOLEAN NOT NULL DEFAULT false,
  free_shipping_threshold_cents INTEGER,
  free_gift_variant_id TEXT,
  free_gift_product_title TEXT,
  free_gift_image_url TEXT,
  free_gift_min_quantity INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pricing_rules_workspace ON public.pricing_rules(workspace_id);

ALTER TABLE public.pricing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read pricing_rules" ON public.pricing_rules
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on pricing_rules" ON public.pricing_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Public read pricing_rules" ON public.pricing_rules
  FOR SELECT TO anon USING (true);

-- Product-to-rule assignment
CREATE TABLE public.product_pricing_rule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  pricing_rule_id UUID NOT NULL REFERENCES public.pricing_rules(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id)
);

ALTER TABLE public.product_pricing_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_pricing_rule" ON public.product_pricing_rule
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_pricing_rule" ON public.product_pricing_rule
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Public read product_pricing_rule" ON public.product_pricing_rule
  FOR SELECT TO anon USING (true);

-- Subscription settings on workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS subscription_discount_pct INTEGER DEFAULT 25,
  ADD COLUMN IF NOT EXISTS subscription_frequencies JSONB DEFAULT '[{"value": 1, "unit": "months"}, {"value": 2, "unit": "months"}]',
  ADD COLUMN IF NOT EXISTS subscription_free_shipping BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_free_shipping_threshold_cents INTEGER,
  ADD COLUMN IF NOT EXISTS subscription_free_gift_variant_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_free_gift_product_title TEXT,
  ADD COLUMN IF NOT EXISTS subscription_free_gift_image_url TEXT;
