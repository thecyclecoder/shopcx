-- Track last customer reply for sorting
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS last_customer_reply_at TIMESTAMPTZ;
