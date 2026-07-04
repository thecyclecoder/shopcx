-- Phase 4 of twilio-callback-queue-drain: aggregate delivered counter + off-hot-path
-- Received-SMS profile-event rollup.
--
-- Adds:
--   1) sms_campaigns.recipients_delivered — running count of delivered recipients,
--      recounted by the drain (same recount pattern as recipients_sent /
--      recipients_failed in marketing-text.ts send-tick). Default 0 so existing
--      rows are correct pre-backfill.
--   2) sms_campaign_recipients.received_sms_logged_at — idempotency flag for
--      the new watermarked rollup cron. Non-null = "already emitted the
--      profile_events 'Received SMS' row for this recipient". The rollup
--      selects candidates WHERE delivered_at IS NOT NULL AND
--      received_sms_logged_at IS NULL, so running it twice is a no-op after
--      the first pass. Partial index keeps the scan cheap.
--
-- IF NOT EXISTS on both columns keeps the migration idempotent — re-applying
-- against an already-migrated env is a no-op.

ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS recipients_delivered int NOT NULL DEFAULT 0;

ALTER TABLE public.sms_campaign_recipients
  ADD COLUMN IF NOT EXISTS received_sms_logged_at timestamptz;

-- Partial index over the rollup candidate set. The cron scans this
-- constantly; a partial index over "delivered but not-yet-logged" rows
-- keeps the scan bounded to just the tail of un-rolled-up recipients
-- regardless of overall table size.
CREATE INDEX IF NOT EXISTS idx_sms_campaign_recipients_rollup_pending
  ON public.sms_campaign_recipients (delivered_at)
  WHERE delivered_at IS NOT NULL AND received_sms_logged_at IS NULL;
