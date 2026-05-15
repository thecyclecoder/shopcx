-- Persistent Klaviyo profile → customer_id directory.
--
-- Why: Klaviyo's profile_id is a foreign-system identifier that loses
-- meaning once we sunset Klaviyo. Every event that touches our DB
-- should resolve to our internal customer_id at import time, not at
-- analysis time. After cutover, klaviyo_profile_id columns can be
-- dropped entirely — all historical analysis still works because
-- customer_id is the join key throughout.
--
-- The directory is populated incrementally by the
-- klaviyo-engagement-sync cron and the backfill scripts. Email/phone
-- are cached for audit, but customer_id is the actual analysis key.

CREATE TABLE IF NOT EXISTS klaviyo_profile_directory (
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  klaviyo_profile_id TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, klaviyo_profile_id)
);

CREATE INDEX IF NOT EXISTS klaviyo_profile_directory_customer_idx
  ON klaviyo_profile_directory (workspace_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS klaviyo_profile_directory_email_idx
  ON klaviyo_profile_directory (workspace_id, email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS klaviyo_profile_directory_phone_idx
  ON klaviyo_profile_directory (workspace_id, phone)
  WHERE phone IS NOT NULL;

-- Add customer_id to klaviyo_profile_events so import-time resolution
-- can persist directly on the event row, eliminating runtime joins.
ALTER TABLE klaviyo_profile_events
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS klaviyo_profile_events_customer_idx
  ON klaviyo_profile_events (workspace_id, customer_id, datetime DESC)
  WHERE customer_id IS NOT NULL;
