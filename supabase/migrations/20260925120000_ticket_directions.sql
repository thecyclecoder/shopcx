-- ticket_directions — the durable first-touch artifact Sol writes ONCE per ticket.
--
-- Phase 1 of docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md
-- (parent goal: sol-ticket-direction-then-cheap-execution → M1 "The Ticket Direction + first-touch session").
-- One live row per ticket: an explicit intent + context_summary + chosen_path + plan + guardrails
-- authored by Sol's box session on the first touch. Downstream cheap-execution turns read the live
-- row instead of re-running full-context reasoning; a rare inflection supersedes the row (sets
-- superseded_at) and inserts a fresh live row.
--
-- Enum `ticket_direction_path` narrows the path Sol picks: 'playbook' (drive an existing playbook),
-- 'stateless' (single stateless reply — no journey), or 'needs_info' (ask the customer for missing
-- context before any action).
--
-- The partial UNIQUE index on (ticket_id) WHERE superseded_at IS NULL enforces the one-live-row
-- invariant at the database level — two concurrent inserts of a live row for the same ticket race
-- and exactly one succeeds. Idempotent (IF NOT EXISTS everywhere) so the apply script re-runs safely.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_direction_path') THEN
    CREATE TYPE public.ticket_direction_path AS ENUM ('playbook', 'stateless', 'needs_info');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.ticket_directions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  intent text NOT NULL,
  context_summary text NOT NULL,
  chosen_path public.ticket_direction_path NOT NULL,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  guardrails jsonb NOT NULL DEFAULT '{}'::jsonb,
  authored_by text NOT NULL DEFAULT 'sol_box_session',
  authored_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

-- Read-path: "latest Direction for a ticket" — cheap-execution turns pluck the live row per
-- ticket (superseded_at IS NULL) in reverse-chronological order.
CREATE INDEX IF NOT EXISTS ticket_directions_workspace_ticket_authored_at_idx
  ON public.ticket_directions (workspace_id, ticket_id, authored_at DESC);

-- One-live-row invariant: at most one row per ticket where superseded_at IS NULL. Enforced at
-- the DB level so concurrent Sol sessions (retry, double-dispatch) can't create two live rows.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_directions_ticket_live_uidx
  ON public.ticket_directions (ticket_id)
  WHERE superseded_at IS NULL;

-- RLS: service-role only. Every write goes through createAdminClient() from
-- src/lib/ticket-directions.ts (Phase 2 lands the SDK). Per CLAUDE.md.
ALTER TABLE public.ticket_directions ENABLE ROW LEVEL SECURITY;
