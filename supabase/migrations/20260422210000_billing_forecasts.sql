-- Billing forecasts: one pending row per subscription, event-driven updates
-- Tracks expected vs actual revenue per billing cycle

CREATE TABLE public.billing_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id),
  shopify_contract_id TEXT NOT NULL,
  customer_id UUID REFERENCES public.customers(id),

  -- Forecast
  expected_date DATE NOT NULL,
  expected_revenue_cents INTEGER NOT NULL DEFAULT 0,
  expected_items JSONB DEFAULT '[]',  -- snapshot of line items at forecast time

  -- Outcome
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'collected', 'failed', 'cancelled', 'paused', 'moved')),
  actual_revenue_cents INTEGER,
  collected_at TIMESTAMPTZ,
  failure_reason TEXT,

  -- Change tracking
  change_type TEXT,  -- date_change, item_change, interval_change, cancellation, pause, reactivation, dunning_skip
  change_note TEXT,
  previous_date DATE,            -- if date was moved, what it was before
  previous_revenue_cents INTEGER, -- if amount changed, what it was before

  -- Source tracking (for debugging + multi-source dedup)
  source TEXT NOT NULL DEFAULT 'webhook',
    -- webhook, seed, portal, agent, system, dunning

  -- Linking
  created_from TEXT NOT NULL DEFAULT 'subscription_created',
    -- subscription_created, billing_success, activated, seed, date_change, reactivation
  order_id TEXT,          -- Shopify order ID on collection
  order_number TEXT,      -- e.g. SC128525
  billing_attempt_id TEXT, -- Appstle billing attempt GID

  -- Billing interval (for calculating next forecast)
  billing_interval TEXT,       -- WEEK, MONTH, etc.
  billing_interval_count INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one pending forecast per subscription
CREATE UNIQUE INDEX idx_billing_forecasts_pending
  ON billing_forecasts(workspace_id, shopify_contract_id)
  WHERE status = 'pending';

-- Query by date for dashboard
CREATE INDEX idx_billing_forecasts_date
  ON billing_forecasts(workspace_id, expected_date, status);

-- Query by subscription
CREATE INDEX idx_billing_forecasts_contract
  ON billing_forecasts(shopify_contract_id, status);

-- RLS
ALTER TABLE public.billing_forecasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read billing_forecasts" ON public.billing_forecasts
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full on billing_forecasts" ON public.billing_forecasts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON billing_forecasts TO service_role;
GRANT SELECT ON billing_forecasts TO authenticated;
