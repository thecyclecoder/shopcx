-- Daily order snapshots — computed once per day after midnight in store timezone
CREATE TABLE public.daily_order_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  store_timezone TEXT NOT NULL DEFAULT 'America/Chicago',

  -- Recurring (subscription renewals)
  recurring_count INTEGER NOT NULL DEFAULT 0,
  recurring_revenue_cents INTEGER NOT NULL DEFAULT 0,

  -- New subscription checkouts (checkout orders with "First Subscription" tag)
  new_subscription_count INTEGER NOT NULL DEFAULT 0,
  new_subscription_revenue_cents INTEGER NOT NULL DEFAULT 0,

  -- One-time purchases (checkout orders without "First Subscription" tag)
  one_time_count INTEGER NOT NULL DEFAULT 0,
  one_time_revenue_cents INTEGER NOT NULL DEFAULT 0,

  -- Replacements (tracked but excluded from revenue calculations)
  replacement_count INTEGER NOT NULL DEFAULT 0,
  replacement_revenue_cents INTEGER NOT NULL DEFAULT 0,

  -- Totals (excludes replacements)
  total_count INTEGER NOT NULL DEFAULT 0,
  total_revenue_cents INTEGER NOT NULL DEFAULT 0,

  -- Shopify validation
  shopify_count INTEGER,
  shopify_mismatch BOOLEAN DEFAULT false,

  -- UTC boundaries used for this snapshot (for debugging)
  utc_start TIMESTAMPTZ NOT NULL,
  utc_end TIMESTAMPTZ NOT NULL,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, snapshot_date)
);

CREATE INDEX idx_daily_order_snapshots_ws_date ON public.daily_order_snapshots(workspace_id, snapshot_date DESC);

ALTER TABLE public.daily_order_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read daily_order_snapshots" ON public.daily_order_snapshots
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on daily_order_snapshots" ON public.daily_order_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);
