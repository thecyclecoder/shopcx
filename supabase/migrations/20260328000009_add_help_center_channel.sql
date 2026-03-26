-- Add help_center as a valid ticket channel
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_channel_check CHECK (channel IN ('email','chat','meta_dm','sms','help_center'));
