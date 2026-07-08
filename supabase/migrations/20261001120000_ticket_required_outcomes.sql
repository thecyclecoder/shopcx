-- ticket_required_outcomes — the structured, individually-checkable "what" behind a customer
-- reply. One row per concrete outcome the ticket-handling pipeline commits to (e.g. "add a
-- second bag to next order", "apply $15 credit", "create a replacement"). The message-is-last
-- pipeline drives off these rows instead of prose:
--   Phase 1 (this migration + SDK) — Sol's session distills the customer's asks into N
--     required-outcome rows with a stored `expected_db_state` predicate that would prove
--     each item done.
--   Phase 2 — the executor honors each row (fires the action + verifies against the DB) BEFORE
--     any reply is composed.
--   Phase 3 — the customer-facing send guard blocks any claim whose backing row isn't
--     status='verified' (ledger stamp verified_outcome='unbacked').
--   Phase 4 — the completion gate keeps the ticket in-progress until every row is verified.
--
-- Parent goal: guaranteed-ticket-handling. Grounded in Judy 0a9e4d7f and the Catherine
-- replacement — messages that promised outcomes that never executed.
--
-- CHECK constraint pins the status enum to {pending, done, verified, failed}. Idempotent
-- (IF NOT EXISTS everywhere) so the apply script re-runs safely.

CREATE TABLE IF NOT EXISTS public.ticket_required_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  direction_id uuid REFERENCES public.ticket_directions(id) ON DELETE SET NULL,
  kind text NOT NULL,
  description text NOT NULL,
  target_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_db_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'verified', 'failed')),
  resolution_event_id uuid REFERENCES public.ticket_resolution_events(id) ON DELETE SET NULL,
  verified_at timestamptz,
  failed_reason text,
  authored_by text NOT NULL DEFAULT 'sol_box_session',
  authored_at timestamptz NOT NULL DEFAULT now()
);

-- Per-ticket "list every required outcome in authored order" — the primary read the completion
-- gate + reply-guard drive off. Also covers the "any pending / any failed" completeness probe
-- through an index-only scan when the caller narrows with .eq('status', …).
CREATE INDEX IF NOT EXISTS ticket_required_outcomes_workspace_ticket_authored_at_idx
  ON public.ticket_required_outcomes (workspace_id, ticket_id, authored_at ASC);

-- Fast completion-gate probe: "does this ticket have any outcome NOT yet verified?"
-- (`status != 'verified'`). A partial index keyed on the still-open subset lets the gate check
-- a ticket without scanning already-verified rows once the queue drains.
CREATE INDEX IF NOT EXISTS ticket_required_outcomes_open_by_ticket_idx
  ON public.ticket_required_outcomes (workspace_id, ticket_id)
  WHERE status <> 'verified';

-- RLS: service-role only. Every write goes through createAdminClient() from
-- src/lib/ticket-required-outcomes.ts. Per CLAUDE.md's "All writes go through
-- createAdminClient()" invariant.
ALTER TABLE public.ticket_required_outcomes ENABLE ROW LEVEL SECURITY;
