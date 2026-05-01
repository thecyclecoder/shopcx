-- API call audit log for direct actions (Appstle and other 3rd-party
-- mutations triggered by Sonnet/Opus action executor). Logs every call,
-- success or failure, so operators can debug 400/500 responses in
-- context — request URL, request body, response status, response body,
-- with a back-link to the ticket that triggered it.

CREATE TABLE IF NOT EXISTS public.appstle_api_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,             -- e.g. "swap_variant", "apply_coupon"
  endpoint TEXT,                         -- short label ("apply-discount", "replace-variants-v3")
  request_method TEXT,
  request_url TEXT NOT NULL,
  request_body JSONB,
  response_status INTEGER,
  response_body TEXT,
  success BOOLEAN NOT NULL,
  error_summary TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appstle_calls_ticket ON public.appstle_api_calls(ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appstle_calls_workspace_recent ON public.appstle_api_calls(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appstle_calls_failures ON public.appstle_api_calls(workspace_id, created_at DESC) WHERE success = false;

ALTER TABLE public.appstle_api_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on appstle_api_calls" ON public.appstle_api_calls
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Workspace members can read appstle_api_calls" ON public.appstle_api_calls
  FOR SELECT TO authenticated USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );
