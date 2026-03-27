-- Add social_comments as a valid ticket channel
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_channel_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_channel_check CHECK (channel IN ('email','chat','meta_dm','sms','help_center','social_comments'));

-- Add social_comments to AI channel config
ALTER TABLE public.ai_channel_config DROP CONSTRAINT IF EXISTS ai_channel_config_channel_check;
ALTER TABLE public.ai_channel_config ADD CONSTRAINT ai_channel_config_channel_check CHECK (channel IN ('email', 'chat', 'sms', 'meta_dm', 'phone', 'help_center', 'social_comments'));
