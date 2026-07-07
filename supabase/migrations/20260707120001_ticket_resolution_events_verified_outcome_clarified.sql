-- ticket_resolution_events.verified_outcome — add 'clarified' to the CHECK.
--
-- Phase 2 of docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md
-- (parent goal: guaranteed-ticket-handling → M2 "The resolution record (the spine)").
-- The selective-clarify gate at the top of executeSonnetDecision's direct_action branch
-- (src/lib/action-executor.ts) short-circuits low-confidence × irreversible plans
-- (partial_refund / cancel / bill_now / subscriptionOrderNow) with a targeted
-- confirmation-turn instead of firing the action. Those turns stamp the ledger row's
-- verified_outcome to 'clarified' so the M4 compiler loop + the /dashboard/tickets/analytics
-- "Selective-clarify rate (target ~6%)" tile can measure the gate's rate directly.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD CONSTRAINT under a DO guard.

DO $$
BEGIN
  ALTER TABLE public.ticket_resolution_events
    DROP CONSTRAINT IF EXISTS ticket_resolution_events_verified_outcome_check;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_resolution_events_verified_outcome_check'
  ) THEN
    ALTER TABLE public.ticket_resolution_events
      ADD CONSTRAINT ticket_resolution_events_verified_outcome_check
      CHECK (verified_outcome IS NULL OR verified_outcome IN ('confirmed','unbacked','drifted','clarified'));
  END IF;
END $$;
