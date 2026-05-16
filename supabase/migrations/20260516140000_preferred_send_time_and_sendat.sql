-- ─────────────────────────────────────────────────────────────────
-- Per-customer optimal SMS send hour + Twilio scheduled-send flow.
--
-- preferred_sms_send_hour is the mode of a customer's Clicked SMS
-- events bucketed by local-hour in their resolved timezone. Computed
-- by scripts/refresh-preferred-send-hour.ts. Null when we don't have
-- enough signal (default: <3 prior clicks).
--
-- When non-null AND > campaign target_local_hour, the scheduler
-- uses this hour instead — message lands when the customer
-- historically clicks SMS, not when we think they will. Never moves
-- a recipient EARLIER than the planned hour (so a campaign
-- scheduled for 9 AM never accidentally fires at 7 AM for someone
-- whose "preferred" hour is earlier).
--
-- twilio_scheduled_sid lets us cancel a scheduled message via DELETE
-- if the campaign is paused / cancelled before SendAt fires.
-- ─────────────────────────────────────────────────────────────────

-- Per-customer click-hour preference
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS preferred_sms_send_hour SMALLINT,
  ADD COLUMN IF NOT EXISTS preferred_sms_send_hour_clicks SMALLINT,
  ADD COLUMN IF NOT EXISTS preferred_sms_send_hour_at TIMESTAMPTZ;

COMMENT ON COLUMN public.customers.preferred_sms_send_hour IS
  '0-23: the local hour this customer most frequently clicks SMS in. Null = insufficient signal.';
COMMENT ON COLUMN public.customers.preferred_sms_send_hour_clicks IS
  'Number of Clicked SMS events that fed the inference. Threshold: 3+.';


-- Per-campaign fallback hour for recipients with no resolvable
-- timezone (timezone_source='fallback'). Distinct from
-- target_local_hour so the admin can say "9 AM if we know your TZ,
-- 10 AM if we don't, sending in Central regardless".
ALTER TABLE public.sms_campaigns
  ADD COLUMN IF NOT EXISTS fallback_target_local_hour SMALLINT DEFAULT 10;


-- Twilio scheduled-message tracking on recipient rows. When the
-- scheduler hands a message to Twilio with SendAt, Twilio returns a
-- SID — we save it so we can DELETE the scheduled message on
-- campaign pause/cancel.
ALTER TABLE public.sms_campaign_recipients
  ADD COLUMN IF NOT EXISTS scheduled_at_twilio TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preferred_hour_used SMALLINT;

COMMENT ON COLUMN public.sms_campaign_recipients.scheduled_at_twilio IS
  'When we successfully handed the message to Twilio SendAt. Null = still pending in our queue.';
COMMENT ON COLUMN public.sms_campaign_recipients.preferred_hour_used IS
  'The local hour we scheduled to — preferred_sms_send_hour if available, else campaign target_local_hour. Audit aid.';


-- Workspace gets a Messaging Service SID for marketing SMS. Stored
-- separately from twilio_phone_number so we keep the long-code
-- (Buen Tiro) flow for transactional SMS while marketing uses the
-- short-code messaging service.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS twilio_marketing_messaging_service_sid TEXT;

COMMENT ON COLUMN public.workspaces.twilio_marketing_messaging_service_sid IS
  'Twilio Messaging Service SID for marketing SMS (e.g. MG…). Sends via this MSSID get server-side scheduling via SendAt and the MS-attached status callback.';
