-- Store the pending auto-reply message so agents can preview it
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS pending_auto_reply TEXT;
