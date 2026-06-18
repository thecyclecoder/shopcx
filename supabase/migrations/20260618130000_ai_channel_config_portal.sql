-- Add 'portal' as a valid AI channel config channel.
-- The tickets.channel constraint already allows 'portal'
-- (20260402200000_add_portal_channel.sql); this brings the
-- per-channel AI settings table in line so the customer portal
-- ("Support" sidebar) gets its own AI Agent Channel config — mirroring
-- live chat — instead of falling back to help_center / defaults.
ALTER TABLE public.ai_channel_config DROP CONSTRAINT IF EXISTS ai_channel_config_channel_check;
ALTER TABLE public.ai_channel_config ADD CONSTRAINT ai_channel_config_channel_check
  CHECK (channel IN ('email', 'chat', 'sms', 'meta_dm', 'phone', 'help_center', 'social_comments', 'portal'));
