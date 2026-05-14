-- ─────────────────────────────────────────────────────────────────
-- Imported Klaviyo SMS campaign history. Used to:
--   1. Surface historical performance in our text marketing UI so
--      admins can compare past campaigns side-by-side.
--   2. Feed an upcoming AI segment builder + scheduler with real
--      performance data — "campaigns sent on Friday morning
--      converted 1.8x better" / "audience X outperformed Y."
--
-- Sourced from the Klaviyo Campaigns + Campaign Values Reports
-- endpoints. One row per Klaviyo campaign. Keyed on the workspace
-- + Klaviyo's own campaign_id so re-imports upsert cleanly.
--
-- We store the resolved values-report stats inline rather than a
-- JSONB blob because we want them queryable / chartable without
-- extracting. The audience segment IDs stay as text arrays because
-- their semantics are Klaviyo-side; we resolve to names at render
-- time via the live segments API.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.klaviyo_sms_campaign_history (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Klaviyo identifiers
  klaviyo_campaign_id         TEXT NOT NULL,                -- e.g. 01KPJZ5Q3QP3Q7R7VM2275XTB5
  klaviyo_campaign_message_id TEXT,                          -- relationship target, holds the body
  channel                     TEXT NOT NULL DEFAULT 'sms',  -- 'sms' for v1; email later

  -- Metadata
  name                        TEXT NOT NULL,
  status                      TEXT,                          -- Sent | Cancelled | Draft (Klaviyo's terms)
  send_time                   TIMESTAMPTZ,
  scheduled_at                TIMESTAMPTZ,
  klaviyo_created_at          TIMESTAMPTZ,
  klaviyo_updated_at          TIMESTAMPTZ,
  is_local_send               BOOLEAN,                       -- recipient-local-time flag from send_strategy

  -- Audience — short Klaviyo segment/list IDs. We resolve to human
  -- names on render via /api/segments/{id} (cached separately).
  audience_included           TEXT[] NOT NULL DEFAULT '{}',
  audience_excluded           TEXT[] NOT NULL DEFAULT '{}',

  -- Message body. Captured from include=campaign-messages on the
  -- campaigns endpoint. Single text field for SMS; MMS media URL
  -- separate so the body stays plain.
  message_body                TEXT,
  message_media_url           TEXT,

  -- Aggregate stats from /api/campaign-values-reports with
  -- conversion_metric_id = Placed Order. Stored as raw values
  -- (counts as integers, rates as numeric) so charts can sort /
  -- aggregate without parsing.
  recipients                  INTEGER,
  delivered                   INTEGER,
  delivery_rate               NUMERIC(8, 6),
  clicks                      INTEGER,
  clicks_unique               INTEGER,
  click_rate                  NUMERIC(8, 6),
  conversions                 INTEGER,
  conversion_rate             NUMERIC(8, 6),
  conversion_value_cents      INTEGER,
  revenue_per_recipient_cents INTEGER,                       -- × 100, integer
  average_order_value_cents   INTEGER,
  unsubscribes                INTEGER,
  unsubscribe_rate            NUMERIC(8, 6),
  spam_complaints             INTEGER,
  spam_complaint_rate         NUMERIC(8, 6),
  bounced                     INTEGER,
  bounce_rate                 NUMERIC(8, 6),
  failed                      INTEGER,
  failed_rate                 NUMERIC(8, 6),

  -- Bookkeeping
  imported_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT klaviyo_sms_campaign_history_workspace_campaign_key
    UNIQUE (workspace_id, klaviyo_campaign_id)
);

CREATE INDEX IF NOT EXISTS klaviyo_sms_campaign_history_workspace_send_idx
  ON public.klaviyo_sms_campaign_history (workspace_id, send_time DESC);
CREATE INDEX IF NOT EXISTS klaviyo_sms_campaign_history_audience_idx
  ON public.klaviyo_sms_campaign_history USING GIN (audience_included);


-- RLS
ALTER TABLE public.klaviyo_sms_campaign_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY klaviyo_sms_campaign_history_workspace_read
  ON public.klaviyo_sms_campaign_history
  FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY klaviyo_sms_campaign_history_service_all
  ON public.klaviyo_sms_campaign_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);
