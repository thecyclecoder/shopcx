-- Human directive: analyzer_locked — a human's veto over the ticket
-- analyzer (Phase 2 of human-directives-hard-gates-over-ticket-ai). When
-- a person manually closes+unescalates a previously-escalated ticket, or
-- clicks "Lock from analyzer / Approve handling" on the ticket detail
-- view, the row's analyzer_locked flips true and the ticket-analysis-cron
-- refuses to re-select it (an updated_at bump can no longer trip the
-- close → analyze → reopen → close loop). Non-propagating on merge —
-- the surviving ticket keeps its own value. Distinct from Phase 1's
-- ai_disabled (which stops the inbound HANDLER too); analyzer_locked
-- only stops the after-the-fact GRADER + auto-reopen path.

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS analyzer_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Partial index — the analyzer cron's find-tickets step scans a bounded
-- window of closed AI tickets and needs to filter out locked rows
-- cheaply. Same shape as idx_tickets_ai_disabled (workspace_id +
-- nullable flag); Postgres uses it for the .eq("analyzer_locked",false)
-- selection predicate.
CREATE INDEX IF NOT EXISTS idx_tickets_analyzer_locked
  ON public.tickets (workspace_id)
  WHERE analyzer_locked = true;
