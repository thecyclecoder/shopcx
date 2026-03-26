-- Journeys: tokenized customer-facing mini-forms for retention flows

-- Journey definitions (workspace-scoped templates)
CREATE TABLE public.journey_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  journey_type TEXT NOT NULL CHECK (journey_type IN ('cancellation', 'win_back', 'pause', 'product_swap', 'custom')),
  config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, slug)
);

CREATE INDEX idx_journey_definitions_workspace ON public.journey_definitions(workspace_id, is_active);

ALTER TABLE public.journey_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view journeys in their workspace" ON public.journey_definitions FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full access on journey definitions" ON public.journey_definitions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Journey sessions (one per customer per journey invocation)
CREATE TABLE public.journey_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  journey_id UUID NOT NULL REFERENCES public.journey_definitions(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE,
  token_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'expired', 'abandoned')),
  current_step INT NOT NULL DEFAULT 0,
  responses JSONB NOT NULL DEFAULT '{}',
  config_snapshot JSONB NOT NULL DEFAULT '{}',
  outcome TEXT,
  outcome_action_taken BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_journey_sessions_token ON public.journey_sessions(token);
CREATE INDEX idx_journey_sessions_workspace ON public.journey_sessions(workspace_id, status);
CREATE INDEX idx_journey_sessions_customer ON public.journey_sessions(customer_id);
CREATE INDEX idx_journey_sessions_ticket ON public.journey_sessions(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_journey_sessions_expiry ON public.journey_sessions(token_expires_at) WHERE status IN ('pending', 'in_progress');

ALTER TABLE public.journey_sessions ENABLE ROW LEVEL SECURITY;
-- No authenticated read — public API validates token directly via service role
CREATE POLICY "Service role full access on journey sessions" ON public.journey_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Journey step events (append-only audit log)
CREATE TABLE public.journey_step_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.journey_sessions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  step_key TEXT NOT NULL,
  response_value TEXT NOT NULL,
  response_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_journey_step_events_session ON public.journey_step_events(session_id);
CREATE INDEX idx_journey_step_events_workspace ON public.journey_step_events(workspace_id);

ALTER TABLE public.journey_step_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on journey step events" ON public.journey_step_events FOR ALL TO service_role USING (true) WITH CHECK (true);
