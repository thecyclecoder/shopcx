-- ─────────────────────────────────────────────────────────────────
-- Klaviyo Placed Order events + Initial Revenue attribution.
--
-- Klaviyo's "Initial Revenue" conversion metric isn't exposed via
-- the public API — it's a UI-only saved filter on Placed Order
-- excluding source_name LIKE 'subscription_contract%'. The reports
-- API only accepts a raw conversion_metric_id with no slot for the
-- per-event filter, so we mirror Placed Order events into our own
-- DB and compute Initial Revenue locally.
--
-- This is also the foundation for the predicted-purchase segment
-- project (see memory: project_predicted_purchase_segments) — once
-- events live in our DB, we can build per-profile feature matrices
-- and train conversion predictors per send.
--
-- klaviyo_events is generic — designed to hold any metric, not just
-- Placed Order, so later importers (Clicked SMS, Active on Site,
-- Received SMS) reuse the same table. Common high-cardinality
-- properties are denormalized as top-level columns for fast
-- querying; everything else stays in event_properties JSONB.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.klaviyo_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Klaviyo identifiers
  klaviyo_event_id    TEXT NOT NULL,
  klaviyo_metric_id   TEXT NOT NULL,           -- e.g. VCkHuL for Placed Order
  klaviyo_profile_id  TEXT,                     -- nullable: some events are profile-less

  -- When the event happened (Klaviyo's `timestamp`/`datetime`)
  datetime            TIMESTAMPTZ NOT NULL,

  -- $value field on the event — used for revenue metrics. NUMERIC
  -- so we don't lose precision on cents conversion done at query
  -- time. Null for non-revenue metrics.
  value               NUMERIC(12, 2),

  -- Denormalized properties we filter on routinely. Saves a JSONB
  -- lookup per row in the attribution query.
  source_name         TEXT,                     -- Shopify Source Name
  order_number        TEXT,                     -- for joining to our orders table

  -- Full property bag. Klaviyo events carry rich Shopify order
  -- detail; storing everything lets us run new attribution queries
  -- without re-pulling from Klaviyo.
  event_properties    JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Bookkeeping
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT klaviyo_events_workspace_event_key
    UNIQUE (workspace_id, klaviyo_event_id)
);

-- The hot index — per-workspace, per-metric, scan by recency. Used
-- by the attribution compute: "all Placed Order events in 7 days
-- after campaign send_time."
CREATE INDEX IF NOT EXISTS klaviyo_events_workspace_metric_datetime_idx
  ON public.klaviyo_events (workspace_id, klaviyo_metric_id, datetime DESC);

-- Per-profile lookup. Powers the predicted-purchase feature matrix
-- when that ships.
CREATE INDEX IF NOT EXISTS klaviyo_events_profile_datetime_idx
  ON public.klaviyo_events (workspace_id, klaviyo_profile_id, datetime DESC)
  WHERE klaviyo_profile_id IS NOT NULL;

-- Excludes subscription orders fast — filter is exactly what the
-- attribution compute applies.
CREATE INDEX IF NOT EXISTS klaviyo_events_revenue_attribution_idx
  ON public.klaviyo_events (workspace_id, klaviyo_metric_id, datetime DESC)
  WHERE source_name IS NOT NULL AND source_name NOT LIKE 'subscription_contract%';


-- ── Initial Revenue columns on the campaign history table ────────
-- "Initial Revenue" = Placed Order revenue excluding subscription
-- auto-renewals, computed locally from klaviyo_events. Keeps both
-- numbers side-by-side so we can see the lift gap.
ALTER TABLE public.klaviyo_sms_campaign_history
  ADD COLUMN IF NOT EXISTS initial_conversions INTEGER,
  ADD COLUMN IF NOT EXISTS initial_conversion_value_cents INTEGER,
  ADD COLUMN IF NOT EXISTS initial_average_order_value_cents INTEGER,
  ADD COLUMN IF NOT EXISTS initial_revenue_computed_at TIMESTAMPTZ;


-- ── RLS ──────────────────────────────────────────────────────────
ALTER TABLE public.klaviyo_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY klaviyo_events_workspace_read ON public.klaviyo_events
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY klaviyo_events_service_all ON public.klaviyo_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
