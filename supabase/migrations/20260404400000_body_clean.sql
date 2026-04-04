-- Add body_clean column for AI-processed email content
-- body = raw original (shown in dashboard)
-- body_clean = stripped of signatures, quotes, HTML (used by AI/classifier)
ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS body_clean TEXT;
