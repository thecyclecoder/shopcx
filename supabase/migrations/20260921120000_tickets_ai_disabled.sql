-- Human directive: per-ticket "turn off AI" hard gate (Phase 1 of
-- human-directives-hard-gates-over-ticket-ai). A human sets this on a
-- single ticket to stop the ai handler AND the ticket-analyzer cron
-- from touching it again. Non-propagating — a merge does NOT carry
-- this forward to the target. Mirrors the shape of do_not_reply
-- (blocks outbound) + adds actor + timestamp so the audit trail
-- survives a rename or an ownership handoff.

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS ai_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_disabled_at timestamptz;

-- Partial index — the analyzer cron and the handler need to short-circuit
-- these rows cheaply. Same shape as the do_not_reply short-circuit
-- callers use (workspace_id + a nullable flag).
CREATE INDEX IF NOT EXISTS idx_tickets_ai_disabled
  ON public.tickets (workspace_id)
  WHERE ai_disabled = true;
