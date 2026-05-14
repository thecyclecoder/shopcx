-- Per-profile Klaviyo engagement event mirror + rollup summary.
--
-- klaviyo_profile_events: raw event mirror (low-cardinality columns only —
--   we don't need every property, just metric + datetime + profile).
--   Idempotent via klaviyo_event_id unique key. Auto-prunes after 180 days
--   via a cleanup cron (TBD; for now retain everything).
--
-- profile_engagement_summary: pre-computed rolling-window counts per
--   profile. Refreshed nightly (or after backfill) from the events table.
--   Joined to customers via email/phone for the segment builder.

CREATE TABLE IF NOT EXISTS klaviyo_profile_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  klaviyo_profile_id TEXT NOT NULL,
  klaviyo_event_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  datetime TIMESTAMPTZ NOT NULL,
  -- Optional: store the $value or $extra for ATC/Checkout events so we
  -- can know cart value without re-pulling. event_properties is full
  -- payload, but we keep it compact for the hot metrics.
  value_cents INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS klaviyo_profile_events_event_unique
  ON klaviyo_profile_events (workspace_id, klaviyo_event_id);
CREATE INDEX IF NOT EXISTS klaviyo_profile_events_profile_metric_dt
  ON klaviyo_profile_events (workspace_id, klaviyo_profile_id, metric_name, datetime DESC);
CREATE INDEX IF NOT EXISTS klaviyo_profile_events_metric_dt
  ON klaviyo_profile_events (workspace_id, metric_name, datetime DESC);

ALTER TABLE klaviyo_profile_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON klaviyo_profile_events
  FOR ALL TO service_role USING (true);

-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profile_engagement_summary (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  klaviyo_profile_id TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT,
  phone TEXT,

  -- Rolling-window counts. 30/60/90/180 day buckets cover all the
  -- archetype rules we discussed; we can add more later if needed.
  clicked_sms_30d INTEGER DEFAULT 0,
  clicked_sms_60d INTEGER DEFAULT 0,
  clicked_sms_180d INTEGER DEFAULT 0,
  opened_email_30d INTEGER DEFAULT 0,
  opened_email_60d INTEGER DEFAULT 0,
  opened_email_180d INTEGER DEFAULT 0,
  clicked_email_30d INTEGER DEFAULT 0,
  clicked_email_60d INTEGER DEFAULT 0,
  viewed_product_30d INTEGER DEFAULT 0,
  viewed_product_90d INTEGER DEFAULT 0,
  added_to_cart_30d INTEGER DEFAULT 0,
  added_to_cart_90d INTEGER DEFAULT 0,
  checkout_started_30d INTEGER DEFAULT 0,
  checkout_started_90d INTEGER DEFAULT 0,
  active_on_site_30d INTEGER DEFAULT 0,
  active_on_site_90d INTEGER DEFAULT 0,

  -- Last-occurrence timestamps for "days since X" features.
  last_clicked_sms_at TIMESTAMPTZ,
  last_opened_email_at TIMESTAMPTZ,
  last_clicked_email_at TIMESTAMPTZ,
  last_viewed_product_at TIMESTAMPTZ,
  last_added_to_cart_at TIMESTAMPTZ,
  last_checkout_started_at TIMESTAMPTZ,
  last_active_on_site_at TIMESTAMPTZ,

  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (workspace_id, klaviyo_profile_id)
);

CREATE INDEX IF NOT EXISTS profile_engagement_summary_customer
  ON profile_engagement_summary (workspace_id, customer_id);
CREATE INDEX IF NOT EXISTS profile_engagement_summary_email
  ON profile_engagement_summary (workspace_id, lower(email));
CREATE INDEX IF NOT EXISTS profile_engagement_summary_phone
  ON profile_engagement_summary (workspace_id, phone);

ALTER TABLE profile_engagement_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON profile_engagement_summary
  FOR ALL TO service_role USING (true);

-- ────────────────────────────────────────────────────────────────────
-- Backfill state tracking on the workspace so the UI can show progress.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS
  klaviyo_engagement_backfill_started_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS
  klaviyo_engagement_backfill_completed_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS
  klaviyo_engagement_last_delta_at TIMESTAMPTZ;
