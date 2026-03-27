-- Coupon management + VIP tier settings

-- VIP threshold on workspace
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS vip_retention_threshold INTEGER NOT NULL DEFAULT 85;

-- Coupon mapping table
CREATE TABLE public.coupon_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  shopify_discount_id TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT,
  value_type TEXT NOT NULL,
  value NUMERIC NOT NULL,
  summary TEXT,
  use_cases TEXT[] NOT NULL DEFAULT '{}',
  customer_tier TEXT NOT NULL DEFAULT 'all' CHECK (customer_tier IN ('all', 'vip', 'non_vip')),
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  agent_enabled BOOLEAN NOT NULL DEFAULT true,
  applies_to_subscriptions BOOLEAN NOT NULL DEFAULT true,
  max_uses_per_customer INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, code)
);

CREATE INDEX idx_coupon_mappings_workspace ON public.coupon_mappings(workspace_id, ai_enabled);

ALTER TABLE public.coupon_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view coupons in their workspace" ON public.coupon_mappings FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on coupon_mappings" ON public.coupon_mappings FOR ALL TO service_role USING (true) WITH CHECK (true);
