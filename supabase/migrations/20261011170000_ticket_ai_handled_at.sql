-- Grading coverage: grade EVERY AI-handled ticket (cheap Sonnet/Haiku path + Sol), not just Sol.
--
-- `sol_handled_at` only marks tickets a Sol box session handled. That leaves our LOW-COST
-- autonomous path (Sonnet/Haiku orchestrator, journeys, playbooks — no Sol) invisible to the
-- Cora cheap-pass grader, so we can't verify the accuracy of the handling that carries most of
-- the volume. `ai_handled_at` is the universal "we responded to the customer" stamp: set in
-- `deliverTicketMessage` for EVERY tier (all customer-facing AI sends flow through it). The Cora
-- grading cron selects on this; `sol_handled_at` stays as the Sol-specific sub-flag (so the
-- dashboard can split "handled cheaply" vs "needed Sol").

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS ai_handled_at timestamptz;

COMMENT ON COLUMN public.tickets.ai_handled_at IS
  'Timestamp of the most recent AI-tier customer response (Haiku/Sonnet orchestrator, Sol, journey, playbook) — stamped in deliverTicketMessage. The universal "we responded" signal the Cora grading cron selects on. sol_handled_at is the Sol-specific sub-flag.';

CREATE INDEX IF NOT EXISTS idx_tickets_ai_handled_at
  ON public.tickets (ai_handled_at)
  WHERE ai_handled_at IS NOT NULL;

-- Backfill recent tickets (7-day window, matching the cron's re-selection horizon) from the
-- latest outbound AI / system-external message, so tickets already handled today become
-- gradeable immediately without waiting for a fresh send. Outbound-only tickets (dunning
-- emails the customer never replied to) get a stamp too, but the grading cron requires a
-- customer message to select a ticket, so they stay excluded from grading regardless.
UPDATE public.tickets t
SET ai_handled_at = sub.max_ai
FROM (
  SELECT ticket_id, MAX(created_at) AS max_ai
  FROM public.ticket_messages
  WHERE author_type = 'ai'
     OR (author_type = 'system' AND visibility = 'external')
  GROUP BY ticket_id
) sub
WHERE t.id = sub.ticket_id
  AND t.ai_handled_at IS NULL
  AND t.created_at >= now() - interval '7 days';
