-- ticket_required_outcomes: add the `waived` terminal-closed status.
--
-- Fixes the uncompletable-policy-forbidden-required-outcome loop (ticket aaf00047): Sol authored
-- an `apply_loyalty_coupon` required outcome against a PAUSED subscription, which the active
-- loyalty rule forbids and which fails upstream with `subscription_not_active`. The row sat in
-- `status='failed'` forever — the only path that clears a failed row needs a successfully-fired
-- rescue action that can never happen by policy — so the Phase-4 completion gate re-escalated the
-- fully-resolved ticket on every reopen.
--
-- `waived` is a second terminal-closed status alongside `verified`: a waived outcome correctly did
-- NOT happen (completing it is policy-forbidden), so the completion gate opens on it. See
-- src/lib/required-outcome-policy.ts (the shared assessPolicyForbidden rule) and
-- src/lib/outcome-completion-gate.ts (waivePolicyForbiddenOutcomes).
--
-- Idempotent: drops + re-adds the CHECK constraint with the widened enum, and recreates the
-- open-rows partial index so a waived row is excluded from the "still open" subset the gate probes.

ALTER TABLE public.ticket_required_outcomes
  DROP CONSTRAINT IF EXISTS ticket_required_outcomes_status_check;

ALTER TABLE public.ticket_required_outcomes
  ADD CONSTRAINT ticket_required_outcomes_status_check
  CHECK (status IN ('pending', 'done', 'verified', 'failed', 'waived'));

-- The completion-gate probe is "does this ticket have any outcome NOT yet terminally closed?".
-- A waived row is closed (correctly-not-done), so it must drop out of the open subset the same way
-- a verified row does. Recreate the partial index to cover status NOT IN ('verified','waived').
DROP INDEX IF EXISTS public.ticket_required_outcomes_open_by_ticket_idx;
CREATE INDEX IF NOT EXISTS ticket_required_outcomes_open_by_ticket_idx
  ON public.ticket_required_outcomes (workspace_id, ticket_id)
  WHERE status NOT IN ('verified', 'waived');
