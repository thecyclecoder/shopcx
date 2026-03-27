ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tickets_snoozed ON public.tickets(snoozed_until) WHERE snoozed_until IS NOT NULL;
