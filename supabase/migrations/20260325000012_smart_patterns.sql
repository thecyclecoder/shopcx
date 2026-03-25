-- Smart pattern system: global pattern library + workspace-specific patterns

CREATE TABLE public.smart_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE, -- NULL = global
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  phrases JSONB NOT NULL DEFAULT '[]',
  match_target TEXT DEFAULT 'body' CHECK (match_target IN ('subject', 'body', 'both')),
  priority INTEGER DEFAULT 50,
  auto_tag TEXT,
  auto_action TEXT,
  active BOOLEAN DEFAULT true,
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'seed', 'nightly_analyzer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_smart_patterns_workspace ON public.smart_patterns(workspace_id, active);
CREATE INDEX idx_smart_patterns_global ON public.smart_patterns(active) WHERE workspace_id IS NULL;

ALTER TABLE public.smart_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view global and workspace patterns"
  ON public.smart_patterns FOR SELECT TO authenticated
  USING (
    workspace_id IS NULL
    OR workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on smart_patterns"
  ON public.smart_patterns FOR ALL
  USING (auth.role() = 'service_role');

-- Per-workspace overrides for global patterns (enable/dismiss)
CREATE TABLE public.workspace_pattern_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pattern_id UUID NOT NULL REFERENCES public.smart_patterns(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(workspace_id, pattern_id)
);

ALTER TABLE public.workspace_pattern_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view overrides in their workspaces"
  ON public.workspace_pattern_overrides FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on workspace_pattern_overrides"
  ON public.workspace_pattern_overrides FOR ALL
  USING (auth.role() = 'service_role');

-- Seed global patterns from Gorgias ticket analysis
INSERT INTO public.smart_patterns (workspace_id, category, name, phrases, match_target, priority, auto_tag, source) VALUES
(NULL, 'not_delivered', 'Not delivered / lost package', '["says delivered", "not delivered", "didn''t receive", "missing package", "lost", "stolen", "no sign of this delivery", "nothing had been delivered", "no delivery", "was not in the box", "never arrived", "never received"]', 'both', 90, 'not-delivered', 'seed'),
(NULL, 'cancel_request', 'Cancellation request', '["cancel my subscription", "cancel my order", "cancel my account", "want to cancel", "need to cancel", "stop my subscription", "stop sending", "don''t want anymore", "discontinue", "end my subscription", "unsubscribe"]', 'both', 60, 'cancel-request', 'seed'),
(NULL, 'return_request', 'Return / exchange', '["return", "exchange", "send it back", "return label", "wrong item", "wrong flavor", "damaged", "broken", "refund", "money back"]', 'both', 55, 'return-request', 'seed'),
(NULL, 'where_is_order', 'Where is my order', '["where is my order", "where''s my order", "have not received", "haven''t received", "not received", "still have not received", "did not receive", "we did not receive", "taking so long", "has been delayed", "where is it", "when will i get"]', 'both', 50, 'where-is-order', 'seed'),
(NULL, 'tracking_status', 'Tracking inquiry', '["tracking number", "tracking info", "track my", "shipment status", "delivery status", "shipping update", "in transit", "been stuck", "check this shipment", "stuck in transit"]', 'both', 45, 'tracking', 'seed'),
(NULL, 'subscription_mgmt', 'Subscription management', '["next shipment", "when will my order ship", "change frequency", "change delivery date", "pause my orders", "skip my order", "hold my orders", "ship now", "ship right away", "ship asap", "move up", "order schedule", "change shipping date", "every three months", "bi monthly"]', 'both', 40, 'subscription', 'seed');
