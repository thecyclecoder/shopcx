-- ══════════════════════════════════════════════════════════
-- Chargeback Monitor: tables, indexes, RLS, settings
-- ══════════════════════════════════════════════════════════

-- ── 1. Add chargeback_alert to dashboard_notifications type ──

ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;

ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check
  CHECK (type IN ('macro_suggestion', 'pattern_review', 'knowledge_gap', 'system', 'fraud_alert', 'chargeback_alert'));

-- ── 2. Add chargeback settings to workspaces ────────────

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS chargeback_auto_cancel BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chargeback_notify BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chargeback_auto_ticket BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chargeback_evidence_reminder_days INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS chargeback_evidence_reminder BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS chargeback_auto_cancel_reasons TEXT[] NOT NULL DEFAULT '{fraudulent,unrecognized}';

-- ── 3. chargeback_events table ──────────────────────────

CREATE TABLE public.chargeback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  shopify_dispute_id TEXT NOT NULL,
  shopify_order_id TEXT,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  dispute_type TEXT NOT NULL CHECK (dispute_type IN ('chargeback', 'inquiry')),
  reason TEXT CHECK (reason IN (
    'fraudulent', 'unrecognized', 'duplicate',
    'subscription_cancelled', 'product_unacceptable',
    'product_not_received', 'credit_not_processed'
  )),
  network_reason_code TEXT,
  amount_cents INT,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'under_review' CHECK (status IN ('under_review', 'accepted', 'won', 'lost')),
  evidence_due_by TIMESTAMPTZ,
  evidence_sent_on TIMESTAMPTZ,
  finalized_on TIMESTAMPTZ,
  auto_action_taken TEXT CHECK (auto_action_taken IN ('subscriptions_cancelled', 'flagged_for_review', 'none')),
  auto_action_at TIMESTAMPTZ,
  fraud_case_id UUID REFERENCES public.fraud_cases(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}',
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, shopify_dispute_id)
);

CREATE INDEX idx_chargeback_events_workspace ON public.chargeback_events(workspace_id, status);
CREATE INDEX idx_chargeback_events_customer ON public.chargeback_events(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_chargeback_events_order ON public.chargeback_events(workspace_id, shopify_order_id);
CREATE INDEX idx_chargeback_events_evidence ON public.chargeback_events(workspace_id, evidence_due_by)
  WHERE status = 'under_review' AND evidence_sent_on IS NULL;

-- ── 4. chargeback_subscription_actions table ────────────

CREATE TABLE public.chargeback_subscription_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chargeback_event_id UUID NOT NULL REFERENCES public.chargeback_events(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('cancelled', 'flagged', 'reinstated')),
  cancellation_reason TEXT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_by TEXT NOT NULL DEFAULT 'system_auto'
);

CREATE INDEX idx_chargeback_sub_actions_event ON public.chargeback_subscription_actions(chargeback_event_id);
CREATE INDEX idx_chargeback_sub_actions_customer ON public.chargeback_subscription_actions(customer_id);

-- ── 5. RLS policies ─────────────────────────────────────

ALTER TABLE public.chargeback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chargeback_subscription_actions ENABLE ROW LEVEL SECURITY;

-- chargeback_events: admin/owner SELECT
CREATE POLICY "chargeback_events_select" ON public.chargeback_events
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- chargeback_subscription_actions: admin/owner SELECT
CREATE POLICY "chargeback_sub_actions_select" ON public.chargeback_subscription_actions
  FOR SELECT USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM public.workspace_members wm
      WHERE wm.user_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

-- Service role: full access
CREATE POLICY "chargeback_events_service" ON public.chargeback_events
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "chargeback_sub_actions_service" ON public.chargeback_subscription_actions
  FOR ALL USING (true) WITH CHECK (true);

-- ── 6. Stats RPC for chargeback dashboard ───────────────

CREATE OR REPLACE FUNCTION public.chargeback_stats(p_workspace_id UUID)
RETURNS TABLE (
  total_count BIGINT,
  under_review_count BIGINT,
  won_count BIGINT,
  lost_count BIGINT,
  total_amount_cents BIGINT,
  auto_cancelled_count BIGINT,
  evidence_due_soon BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) AS total_count,
    COUNT(*) FILTER (WHERE ce.status = 'under_review') AS under_review_count,
    COUNT(*) FILTER (WHERE ce.status = 'won') AS won_count,
    COUNT(*) FILTER (WHERE ce.status = 'lost') AS lost_count,
    COALESCE(SUM(ce.amount_cents), 0) AS total_amount_cents,
    COUNT(*) FILTER (WHERE ce.auto_action_taken = 'subscriptions_cancelled') AS auto_cancelled_count,
    COUNT(*) FILTER (
      WHERE ce.status = 'under_review'
        AND ce.evidence_sent_on IS NULL
        AND ce.evidence_due_by <= now() + interval '7 days'
    ) AS evidence_due_soon
  FROM public.chargeback_events ce
  WHERE ce.workspace_id = p_workspace_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
