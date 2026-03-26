-- Per-channel response delay settings (in seconds)
-- Workflows and AI auto-replies wait this long before sending
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS response_delays JSONB DEFAULT '{"email": 60, "chat": 5, "sms": 10, "meta_dm": 10}';

-- Timestamp showing when an automated reply is scheduled
-- Visible to agents so they know the ticket is being handled
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS auto_reply_at TIMESTAMPTZ;
