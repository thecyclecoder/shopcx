-- Add help_center to AI channel config constraint
ALTER TABLE public.ai_channel_config DROP CONSTRAINT IF EXISTS ai_channel_config_channel_check;
ALTER TABLE public.ai_channel_config ADD CONSTRAINT ai_channel_config_channel_check CHECK (channel IN ('email', 'chat', 'sms', 'meta_dm', 'phone', 'help_center'));
