-- The Twilio marketing-status webhook handler looks up recipients by
-- message_sid on every status callback (queued/sent/delivered/failed).
-- Each SMS produces ~2-3 status callbacks; an MDW send of 30K recipients
-- generates ~75K status webhooks within a short window. Without an
-- index on message_sid, every one of those was a sequential scan over
-- hundreds of thousands of historical recipient rows (~65ms each).
--
-- This was the #1 DB-time burner in pg_stat_statements (74K calls,
-- 4,826 sec total) and the saturating load that caused the recurring
-- pool lockups during campaign sends.
--
-- message_sid is unique-per-message from Twilio so we make this UNIQUE.
-- WHERE message_sid IS NOT NULL keeps the index small (recipients in
-- 'pending' state have no sid yet).

CREATE UNIQUE INDEX IF NOT EXISTS sms_campaign_recipients_message_sid_idx
  ON public.sms_campaign_recipients (message_sid)
  WHERE message_sid IS NOT NULL;
