-- Track how many times we've re-nudged a customer to complete a journey step
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS journey_nudge_count INTEGER NOT NULL DEFAULT 0;
