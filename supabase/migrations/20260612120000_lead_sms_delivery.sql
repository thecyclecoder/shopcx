-- SMS delivery logging for popup-coupon leads.
--
-- Popup coupon SMS is sent through the Twilio Messaging Service, whose
-- service-level status callback already POSTs to /api/webhooks/twilio/
-- marketing-status. That handler only matched sms_campaign_recipients, so
-- popup-lead callbacks were silently dropped. We now store the message SID on
-- the lead at send time and record the delivery status the webhook reports.

alter table public.storefront_leads
  add column if not exists sms_message_sid text,
  add column if not exists sms_status text,        -- queued|sent|delivered|undelivered|failed
  add column if not exists sms_status_at timestamptz;

create index if not exists idx_storefront_leads_sms_message_sid
  on public.storefront_leads (sms_message_sid) where sms_message_sid is not null;
