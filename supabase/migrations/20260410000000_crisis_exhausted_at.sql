-- Add missing exhausted_at column to crisis_customer_actions
ALTER TABLE public.crisis_customer_actions ADD COLUMN IF NOT EXISTS exhausted_at TIMESTAMPTZ;
