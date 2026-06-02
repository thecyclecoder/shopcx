-- Marker for whether we've sent the CSAT survey email for a ticket.
-- Set by the csat-survey-send cron on first send; used as the filter
-- to avoid re-sending. Distinct from ticket_csat.id which only exists
-- once the customer has actually submitted a response.
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS csat_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tickets_csat_due_idx
  ON public.tickets (workspace_id, closed_at)
  WHERE status = 'closed' AND csat_sent_at IS NULL AND customer_id IS NOT NULL;
