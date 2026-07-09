-- agent_action_requests — the queue that lets Sol's read-only box session request bounded, verified
-- mutations without holding write creds. Sol (Max, read-only) enqueues a validated SonnetDecision;
-- the deterministic execute-worker lane (builder-worker, write creds) claims it, runs it through
-- executeSonnetDecision (the one executor — 39 handlers + journeys/playbooks/workflows + verify +
-- resolution ledger), and writes the verified result back. Sol long-polls the row and crafts her
-- reply from the REAL outcome. Also carries CONDITIONAL/deferred actions (trigger_condition) that a
-- later event (e.g. journey completion) promotes from pending_condition → pending.
--
-- Status lifecycle:
--   pending           — ready to execute now (worker claims it)
--   pending_condition — armed; waits for trigger_condition to be satisfied, then → pending
--   running           — claimed by the worker (atomic claim-guard)
--   done              — executed + verified (result populated)
--   failed            — executed but an action failed (error populated; NO false success sent)
--   expired           — a pending_condition TTL lapsed (customer never met the condition)
CREATE TABLE IF NOT EXISTS public.agent_action_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id),
  ticket_id         uuid NOT NULL REFERENCES public.tickets(id),
  customer_id       uuid REFERENCES public.customers(id),
  direction_id      uuid REFERENCES public.ticket_directions(id),
  status            text NOT NULL DEFAULT 'pending',
  -- the validated SonnetDecision (action_type + actions[] + response_message + handler_name…)
  decision          jsonb NOT NULL,
  -- DRY RUN: when true the execute-worker runs with ctx.sandbox=true — every action is simulated
  -- ("would do X", no real Appstle/Braintree/Shopify call) and any reply is stored as an internal
  -- draft, never sent. result records what WOULD have happened. Lets us rehearse Sol on a REAL
  -- ticket through the real code path with zero side effects, then review.
  dry_run           boolean NOT NULL DEFAULT false,
  -- null = execute immediately; else {type, ...} — the condition that must hold before running
  trigger_condition jsonb,
  -- verified outcome {messageSent, escalated, closed, statusManaged, actions:[{type,success,summary,error}]}
  result            jsonb,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  claimed_at        timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  -- TTL for pending_condition rows (abandonment); null for immediate requests
  expires_at        timestamptz
);

-- Worker claim scan: pending rows oldest-first, scoped by status.
CREATE INDEX IF NOT EXISTS idx_agent_action_requests_claim
  ON public.agent_action_requests (status, created_at)
  WHERE status IN ('pending', 'pending_condition');

-- Sol's long-poll + per-ticket lookups.
CREATE INDEX IF NOT EXISTS idx_agent_action_requests_ticket
  ON public.agent_action_requests (ticket_id, created_at DESC);

COMMENT ON TABLE public.agent_action_requests IS
  'Queue for Sol''s enqueue→worker-execute→poll model: read-only box session requests a validated SonnetDecision; the deterministic execute-worker runs it via executeSonnetDecision and writes the verified result. Also holds conditional/deferred actions (trigger_condition).';
