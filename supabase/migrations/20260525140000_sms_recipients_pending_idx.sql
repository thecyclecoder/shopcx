-- pick-due-recipients in textCampaignSendTick was the #1 DB time burner
-- in production (304s per 5 min live, projected ~12h of DB-time per 12h
-- real time). The query:
--   WHERE status='pending'
--     AND scheduled_at_twilio IS NULL
--     AND scheduled_send_at <= $1
--   ORDER BY scheduled_send_at ASC
--   LIMIT 1000
-- With sms_campaign_recipients holding hundreds of thousands of rows
-- across all past campaigns, an unindexed status filter forced a
-- sequential scan every minute. Partial+ordered index turns it into
-- a trivial range scan.

CREATE INDEX IF NOT EXISTS sms_campaign_recipients_pick_due_idx
  ON public.sms_campaign_recipients (scheduled_send_at)
  WHERE status = 'pending' AND scheduled_at_twilio IS NULL;
