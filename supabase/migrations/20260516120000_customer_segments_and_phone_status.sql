-- ─────────────────────────────────────────────────────────────────
-- Customer segment membership + phone status + campaign segment
-- filtering.
--
-- Segments are independent boolean tags (not mutually exclusive).
-- A customer can live in multiple. Campaigns pick include + exclude
-- sets; "priority" is implemented by excluding higher-tier segments
-- when sending to a lower-tier one.
--
-- See TEXT-MARKETING.md § "Predictive segmentation" for the 7
-- archetype predicates + active_sub flag. Refreshed by
-- scripts/refresh-customer-segments.ts.
--
-- phone_status captures Twilio fatal-error outcomes so future sends
-- skip the customer automatically. Hard safety net at the recipient
-- resolution layer.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS segments TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS segments_refreshed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_status TEXT,
  ADD COLUMN IF NOT EXISTS phone_status_code INTEGER,
  ADD COLUMN IF NOT EXISTS phone_status_at TIMESTAMPTZ;

-- GIN index for fast `segments && ARRAY[...]` (array overlap) queries
-- used by recipient resolution.
CREATE INDEX IF NOT EXISTS customers_segments_gin
  ON public.customers USING GIN (segments)
  WHERE workspace_id IS NOT NULL;

-- Partial index for the bad-phone exclusion. Filter is selective —
-- most rows have phone_status NULL.
CREATE INDEX IF NOT EXISTS customers_phone_status_idx
  ON public.customers (workspace_id, phone_status)
  WHERE phone_status IS NOT NULL;


-- ── Campaign segment filtering ──────────────────────────────────
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS included_segments TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS excluded_segments TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN public.sms_campaigns.included_segments IS
  'Recipient must match ≥1 of these segments. Empty array = no segment filter (sends to all SMS-subscribed).';
COMMENT ON COLUMN public.sms_campaigns.excluded_segments IS
  'Recipient must match 0 of these segments. Used for priority cascading (e.g. cycle_hitter excludes engaged).';


-- ── Recipient row: track rate-limit + permanent failure outcomes ──
-- Existing sms_campaign_recipients.status was open-text; we'll
-- expand to use these values:
--   pending, sent, skipped, failed, failed_permanent, skipped_rate_limit
-- No enum constraint — keep flexibility for future.
COMMENT ON COLUMN public.sms_campaign_recipients.status IS
  'pending → sent | skipped | failed (retryable) | failed_permanent (bad phone) | skipped_rate_limit (≤12h since last campaign)';
