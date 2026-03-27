-- ══════════════════════════════════════════════════════════
-- Fraud Monitor: tables, indexes, RLS, seeds
-- ══════════════════════════════════════════════════════════

-- ── 1. Add shipping address columns to orders ────────────

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_address JSONB,
  ADD COLUMN IF NOT EXISTS normalized_shipping_address TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_normalized_address
  ON public.orders(workspace_id, normalized_shipping_address)
  WHERE normalized_shipping_address IS NOT NULL;

-- ── 2. Add suppressed_addresses to workspaces ────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS fraud_suppressed_addresses TEXT[] DEFAULT '{}';

-- ── 3. Add fraud_alert to dashboard_notifications type ───

ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;

ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check
  CHECK (type IN ('macro_suggestion', 'pattern_review', 'knowledge_gap', 'system', 'fraud_alert'));

-- ── 4. fraud_rules table ─────────────────────────────────

CREATE TABLE public.fraud_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  is_seeded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_rules_workspace ON public.fraud_rules(workspace_id, is_active);

-- ── 5. fraud_cases table ─────────────────────────────────

CREATE TABLE public.fraud_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES public.fraud_rules(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'confirmed_fraud', 'dismissed')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  title TEXT NOT NULL,
  summary TEXT,
  evidence JSONB NOT NULL DEFAULT '{}',
  customer_ids UUID[] DEFAULT '{}',
  order_ids TEXT[] DEFAULT '{}',
  assigned_to UUID REFERENCES public.workspace_members(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES public.workspace_members(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  resolution TEXT,
  dismissal_reason TEXT,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_cases_status ON public.fraud_cases(workspace_id, status);
CREATE INDEX idx_fraud_cases_rule_status ON public.fraud_cases(workspace_id, rule_type, status);

-- ── 6. fraud_rule_matches table ──────────────────────────

CREATE TABLE public.fraud_rule_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES public.fraud_cases(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL,
  match_value TEXT NOT NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  order_id TEXT,
  order_amount_cents INT,
  order_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_rule_matches_case ON public.fraud_rule_matches(case_id);
CREATE INDEX idx_fraud_rule_matches_value ON public.fraud_rule_matches(match_value);

-- ── 7. fraud_case_history (audit log) ────────────────────

CREATE TABLE public.fraud_case_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES public.fraud_cases(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_case_history_case ON public.fraud_case_history(case_id, created_at);

-- ── 8. RLS policies — admin/owner only ───────────────────

ALTER TABLE public.fraud_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_rule_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fraud_case_history ENABLE ROW LEVEL SECURITY;

-- fraud_rules: admin/owner SELECT
CREATE POLICY "fraud_rules_select" ON public.fraud_rules
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- fraud_cases: admin/owner SELECT
CREATE POLICY "fraud_cases_select" ON public.fraud_cases
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- fraud_rule_matches: admin/owner SELECT
CREATE POLICY "fraud_rule_matches_select" ON public.fraud_rule_matches
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- fraud_case_history: admin/owner SELECT
CREATE POLICY "fraud_case_history_select" ON public.fraud_case_history
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- Service role: full access (all tables)
CREATE POLICY "fraud_rules_service" ON public.fraud_rules
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "fraud_cases_service" ON public.fraud_cases
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "fraud_rule_matches_service" ON public.fraud_rule_matches
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "fraud_case_history_service" ON public.fraud_case_history
  FOR ALL USING (true) WITH CHECK (true);

-- ── 9. RPC functions for fraud detection queries ─────────

-- Shared address detection: find address groups exceeding thresholds
CREATE OR REPLACE FUNCTION public.fraud_detect_shared_addresses(
  p_workspace_id UUID,
  p_min_customers INT,
  p_min_orders INT,
  p_cutoff TIMESTAMPTZ
)
RETURNS TABLE (
  normalized_shipping_address TEXT,
  customer_count BIGINT,
  order_count BIGINT,
  customer_ids UUID[],
  last_names TEXT[],
  full_names TEXT[],
  display_address TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    o.normalized_shipping_address,
    COUNT(DISTINCT o.customer_id) AS customer_count,
    COUNT(o.id) AS order_count,
    array_agg(DISTINCT o.customer_id) FILTER (WHERE o.customer_id IS NOT NULL) AS customer_ids,
    array_agg(DISTINCT c.last_name) FILTER (WHERE c.last_name IS NOT NULL) AS last_names,
    array_agg(DISTINCT (COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) FILTER (WHERE c.last_name IS NOT NULL) AS full_names,
    (o.shipping_address->>'address1') AS display_address
  FROM public.orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  WHERE o.workspace_id = p_workspace_id
    AND o.created_at >= p_cutoff
    AND o.normalized_shipping_address IS NOT NULL
    AND o.customer_id IS NOT NULL
  GROUP BY o.normalized_shipping_address, o.shipping_address->>'address1'
  HAVING COUNT(DISTINCT o.customer_id) >= p_min_customers
    AND COUNT(o.id) >= p_min_orders;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- High velocity detection: find customers with many high-quantity orders
CREATE OR REPLACE FUNCTION public.fraud_detect_high_velocity(
  p_workspace_id UUID,
  p_min_quantity INT,
  p_min_orders INT,
  p_window_cutoff TIMESTAMPTZ,
  p_lookback_cutoff TIMESTAMPTZ
)
RETURNS TABLE (
  customer_id UUID,
  qualifying_order_count BIGINT,
  order_ids UUID[],
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH qualifying_orders AS (
    SELECT
      o.customer_id AS cust_id,
      o.id AS oid,
      o.created_at AS order_date,
      (SELECT COALESCE(SUM((li->>'quantity')::int), 0)
       FROM jsonb_array_elements(o.line_items) AS li) AS total_items
    FROM public.orders o
    WHERE o.workspace_id = p_workspace_id
      AND o.created_at >= p_lookback_cutoff
      AND o.customer_id IS NOT NULL
      AND o.subscription_id IS NULL
  )
  SELECT
    q.cust_id AS customer_id,
    COUNT(*) AS qualifying_order_count,
    array_agg(q.oid) AS order_ids,
    MIN(q.order_date) AS window_start,
    MAX(q.order_date) AS window_end
  FROM qualifying_orders q
  WHERE q.total_items >= p_min_quantity
    AND q.order_date >= p_window_cutoff
  GROUP BY q.cust_id
  HAVING COUNT(*) >= p_min_orders;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 10a. Stats RPC for fraud dashboard ───────────────────

CREATE OR REPLACE FUNCTION public.fraud_case_stats(p_workspace_id UUID)
RETURNS TABLE (
  open_count BIGINT,
  confirmed_30d BIGINT,
  dismissed_30d BIGINT,
  value_at_risk_cents BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE fc.status = 'open') AS open_count,
    COUNT(*) FILTER (WHERE fc.status = 'confirmed_fraud' AND fc.reviewed_at >= now() - interval '30 days') AS confirmed_30d,
    COUNT(*) FILTER (WHERE fc.status = 'dismissed' AND fc.reviewed_at >= now() - interval '30 days') AS dismissed_30d,
    COALESCE(SUM(
      CASE WHEN fc.status IN ('open', 'reviewing') THEN
        COALESCE((fc.evidence->>'total_order_value_cents')::bigint, (fc.evidence->>'total_spend_in_window_cents')::bigint, 0)
      ELSE 0 END
    ), 0) AS value_at_risk_cents
  FROM public.fraud_cases fc
  WHERE fc.workspace_id = p_workspace_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 10b. Append suppressed address helper ────────────────

CREATE OR REPLACE FUNCTION public.append_suppressed_address(
  p_workspace_id UUID,
  p_address TEXT
)
RETURNS void AS $$
BEGIN
  UPDATE public.workspaces
  SET fraud_suppressed_addresses = array_append(
    COALESCE(fraud_suppressed_addresses, '{}'),
    p_address
  )
  WHERE id = p_workspace_id
    AND NOT (p_address = ANY(COALESCE(fraud_suppressed_addresses, '{}')));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 11. Seed function for default fraud rules ─────────────
-- Called on workspace creation and can be called manually

CREATE OR REPLACE FUNCTION public.seed_fraud_rules(p_workspace_id UUID)
RETURNS void AS $$
BEGIN
  -- Shared Address rule
  INSERT INTO public.fraud_rules (workspace_id, rule_type, name, description, is_active, config, severity, is_seeded)
  VALUES (
    p_workspace_id,
    'shared_address',
    'Multiple accounts — same address',
    'Flags when 3 or more distinct customer accounts share the same shipping address, especially with different names and high order volume.',
    true,
    '{"min_customers": 3, "min_orders_total": 5, "ignore_same_last_name": true, "lookback_days": 365}',
    'high',
    true
  ) ON CONFLICT DO NOTHING;

  -- High Velocity rule
  INSERT INTO public.fraud_rules (workspace_id, rule_type, name, description, is_active, config, severity, is_seeded)
  VALUES (
    p_workspace_id,
    'high_velocity',
    'Unusually high order frequency',
    'Flags when a single customer orders 4 or more units of any item on 3 or more separate occasions within a 60-day rolling window.',
    true,
    '{"min_quantity_per_order": 4, "min_qualifying_orders": 3, "window_days": 60, "lookback_days": 365}',
    'medium',
    true
  ) ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 11. Seed rules for all existing workspaces ───────────

DO $$
DECLARE
  ws RECORD;
BEGIN
  FOR ws IN SELECT id FROM public.workspaces LOOP
    PERFORM public.seed_fraud_rules(ws.id);
  END LOOP;
END;
$$;
