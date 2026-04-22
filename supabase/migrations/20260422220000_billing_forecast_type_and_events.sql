-- Add forecast_type to billing_forecasts and create events audit trail

-- forecast_type: renewal (standard), dunning (retry), paused (resume pending)
ALTER TABLE public.billing_forecasts ADD COLUMN IF NOT EXISTS forecast_type TEXT NOT NULL DEFAULT 'renewal'
  CHECK (forecast_type IN ('renewal', 'dunning', 'paused'));

-- Forecast change events: append-only audit trail
-- Dashboard groups by event_type to show how static forecast changed
CREATE TABLE public.billing_forecast_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  forecast_id UUID NOT NULL REFERENCES public.billing_forecasts(id) ON DELETE CASCADE,
  shopify_contract_id TEXT NOT NULL,
  forecast_date DATE NOT NULL,

  event_type TEXT NOT NULL,
    -- new_subscription, cancellation, pause, resume, item_change,
    -- date_change_out, date_change_in, interval_change, billing_success,
    -- billing_failure, dunning_recovery, reactivation
  delta_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_forecast_events_date
  ON billing_forecast_events(workspace_id, forecast_date, event_type);

CREATE INDEX idx_billing_forecast_events_forecast
  ON billing_forecast_events(forecast_id);

ALTER TABLE public.billing_forecast_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read billing_forecast_events" ON public.billing_forecast_events
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full on billing_forecast_events" ON public.billing_forecast_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON billing_forecast_events TO service_role;
GRANT SELECT ON billing_forecast_events TO authenticated;
