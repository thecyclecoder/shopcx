-- ticket_resolution_events — the write-ahead ledger for every orchestrator turn.
--
-- Phase 1 of docs/brain/specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension.md
-- (parent goal: guaranteed-ticket-handling → M2 "The resolution record (the spine)"). One row per
-- executeSonnetDecision() run, inserted at the top of the executor BEFORE any customer-facing claim
-- ships. Every branch (direct_action, journey, playbook, workflow, macro, kb_response, ai_response,
-- escalate) shares the same row. staged_at is stamped at insert; shipped_at is stamped from the
-- sendReply path; verified_at + verified_outcome are stamped from the verifyActionInDB outcome
-- (or, for message-only branches, from the executor's return-time verdict). This is the substrate
-- M1's inline verify block reads against, M2's confidence-gated clarify keys off, and M4's compiler
-- loop mines — see the parent goal.
--
-- Nothing here is trigger-driven; all writes are explicit inserts/updates from src/lib/action-executor.ts.
-- Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes) so the apply script is safely re-runnable.

CREATE TABLE IF NOT EXISTS public.ticket_resolution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  turn_index int NOT NULL,
  problem text,
  confidence numeric,
  options jsonb,
  chosen jsonb,
  staged_at timestamptz NOT NULL DEFAULT now(),
  shipped_at timestamptz,
  verified_at timestamptz,
  verified_outcome text,
  reasoning text,
  CONSTRAINT ticket_resolution_events_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT ticket_resolution_events_verified_outcome_check CHECK (
    verified_outcome IS NULL OR verified_outcome IN ('confirmed','unbacked','drifted')
  )
);

-- Read-path: "all resolution events for a ticket in turn order" — the spec's Phase-1
-- verification queries per-ticket ordering, and the M4 compiler loop mines by ticket.
CREATE INDEX IF NOT EXISTS ticket_resolution_events_workspace_ticket_turn_idx
  ON public.ticket_resolution_events (workspace_id, ticket_id, turn_index);

-- Read-path: reporting rollups ("problem/confidence distribution across the last day")
-- from the spec's Phase-2 verification bullet. Latest-first for the dashboard.
CREATE INDEX IF NOT EXISTS ticket_resolution_events_workspace_staged_at_idx
  ON public.ticket_resolution_events (workspace_id, staged_at DESC);

-- RLS: service-role only. Every write goes through createAdminClient() from
-- src/lib/action-executor.ts (see CLAUDE.md "All writes go through createAdminClient()").
ALTER TABLE public.ticket_resolution_events ENABLE ROW LEVEL SECURITY;
