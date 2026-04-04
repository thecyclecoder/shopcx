-- Stand firm rounds between exception tiers + disqualifier checks
ALTER TABLE public.playbooks ADD COLUMN IF NOT EXISTS stand_firm_before_exceptions INTEGER NOT NULL DEFAULT 2;
ALTER TABLE public.playbooks ADD COLUMN IF NOT EXISTS stand_firm_between_tiers INTEGER NOT NULL DEFAULT 2;
ALTER TABLE public.playbooks ADD COLUMN IF NOT EXISTS exception_disqualifiers JSONB NOT NULL DEFAULT '[]';
-- disqualifier types: "previous_exception" (checks returns table), "has_chargeback" (checks chargeback_events table)
ALTER TABLE public.playbooks ADD COLUMN IF NOT EXISTS disqualifier_behavior TEXT NOT NULL DEFAULT 'silent';
-- "silent" = never mention why, just stand firm. "explicit" = tell customer why they don't qualify.
