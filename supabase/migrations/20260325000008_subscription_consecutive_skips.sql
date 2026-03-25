-- Track consecutive billing skips for auto-cancel rules
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS consecutive_skips INTEGER DEFAULT 0;
