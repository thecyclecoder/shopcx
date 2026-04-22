-- Pre-computed monthly revenue snapshots for fast dashboard loading
-- Rebuilt nightly by cron from daily_order_snapshots + daily_amazon_order_snapshots

CREATE TABLE public.monthly_revenue_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- YYYY-MM

  -- Shopify
  recurring_count INTEGER NOT NULL DEFAULT 0,
  recurring_revenue_cents INTEGER NOT NULL DEFAULT 0,
  new_subscription_count INTEGER NOT NULL DEFAULT 0,
  new_subscription_revenue_cents INTEGER NOT NULL DEFAULT 0,
  one_time_count INTEGER NOT NULL DEFAULT 0,
  one_time_revenue_cents INTEGER NOT NULL DEFAULT 0,
  replacement_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  total_revenue_cents INTEGER NOT NULL DEFAULT 0,
  mrr_cents INTEGER NOT NULL DEFAULT 0,
  churn_cents INTEGER NOT NULL DEFAULT 0,
  churn_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  prev_mrr_cents INTEGER NOT NULL DEFAULT 0,
  net_mrr_cents INTEGER NOT NULL DEFAULT 0,
  subscription_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  days_in_month INTEGER NOT NULL DEFAULT 0,
  is_complete BOOLEAN NOT NULL DEFAULT false,
  mismatches INTEGER NOT NULL DEFAULT 0,

  -- Amazon
  amz_recurring_count INTEGER NOT NULL DEFAULT 0,
  amz_recurring_revenue_cents INTEGER NOT NULL DEFAULT 0,
  amz_sns_checkout_count INTEGER NOT NULL DEFAULT 0,
  amz_sns_checkout_revenue_cents INTEGER NOT NULL DEFAULT 0,
  amz_one_time_count INTEGER NOT NULL DEFAULT 0,
  amz_one_time_revenue_cents INTEGER NOT NULL DEFAULT 0,
  amz_total_count INTEGER NOT NULL DEFAULT 0,
  amz_total_revenue_cents INTEGER NOT NULL DEFAULT 0,
  amz_mrr_cents INTEGER NOT NULL DEFAULT 0,
  amz_churn_cents INTEGER NOT NULL DEFAULT 0,
  amz_churn_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
  amz_subscription_rate NUMERIC(6,2) NOT NULL DEFAULT 0,

  -- Meta ad spend
  meta_spend_cents INTEGER NOT NULL DEFAULT 0,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, month)
);

ALTER TABLE public.monthly_revenue_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth read monthly_revenue_snapshots" ON public.monthly_revenue_snapshots
  FOR SELECT TO authenticated USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full monthly_revenue_snapshots" ON public.monthly_revenue_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON monthly_revenue_snapshots TO service_role;
GRANT SELECT ON monthly_revenue_snapshots TO authenticated;
