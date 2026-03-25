-- Append-only customer event log (timeline)
CREATE TABLE public.customer_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT,
  properties JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_events_customer ON public.customer_events(customer_id, created_at DESC);
CREATE INDEX idx_customer_events_workspace ON public.customer_events(workspace_id, created_at DESC);
CREATE INDEX idx_customer_events_type ON public.customer_events(workspace_id, event_type);

ALTER TABLE public.customer_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view customer events in their workspaces"
  ON public.customer_events FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role full access on customer_events"
  ON public.customer_events FOR ALL
  USING (auth.role() = 'service_role');
