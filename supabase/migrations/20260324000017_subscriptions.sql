-- Subscription data from Appstle
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  shopify_contract_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'expired', 'failed')),
  billing_interval TEXT,
  billing_interval_count INTEGER,
  next_billing_date TIMESTAMPTZ,
  last_payment_status TEXT,
  items JSONB DEFAULT '[]',
  delivery_price_cents BIGINT DEFAULT 0,
  shopify_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, shopify_contract_id)
);

CREATE INDEX idx_subscriptions_workspace ON public.subscriptions(workspace_id);
CREATE INDEX idx_subscriptions_customer ON public.subscriptions(customer_id);
CREATE INDEX idx_subscriptions_contract ON public.subscriptions(workspace_id, shopify_contract_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view subscriptions in their workspaces"
  ON public.subscriptions FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on subscriptions"
  ON public.subscriptions FOR ALL
  USING (auth.role() = 'service_role');
