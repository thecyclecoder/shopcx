-- Marketing consent + phone display
ALTER TABLE public.customers
  ADD COLUMN email_marketing_status TEXT DEFAULT 'not_subscribed',
  ADD COLUMN sms_marketing_status TEXT DEFAULT 'not_subscribed';
