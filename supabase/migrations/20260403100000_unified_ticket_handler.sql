-- Unified ticket handler: escalation gap log + clarification tracking

-- Escalation gaps — logged when AI can't route to any handler
CREATE TABLE IF NOT EXISTS public.escalation_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  detected_intent TEXT,
  confidence INTEGER,
  original_message TEXT NOT NULL,
  customer_context_summary TEXT,
  resolved_as TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_escalation_gaps_workspace
  ON public.escalation_gaps (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalation_gaps_unresolved
  ON public.escalation_gaps (workspace_id, resolved_as)
  WHERE resolved_as IS NULL;

ALTER TABLE public.escalation_gaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on escalation_gaps"
  ON public.escalation_gaps FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Members can view escalation_gaps"
  ON public.escalation_gaps FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

-- Add escalation_gap to notification types
ALTER TABLE public.dashboard_notifications
  DROP CONSTRAINT IF EXISTS dashboard_notifications_type_check;
ALTER TABLE public.dashboard_notifications
  ADD CONSTRAINT dashboard_notifications_type_check
  CHECK (type IN ('macro_suggestion', 'pattern_review', 'knowledge_gap', 'system', 'fraud_alert', 'chargeback_alert', 'duplicate_order_alert', 'escalation_gap'));

-- Clarification turn tracking on tickets
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS ai_clarification_turn INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_detected_intent TEXT,
  ADD COLUMN IF NOT EXISTS ai_intent_confidence INTEGER;
