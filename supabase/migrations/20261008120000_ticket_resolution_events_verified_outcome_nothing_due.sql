-- ticket_resolution_events.verified_outcome — add 'nothing_due' to the CHECK.
--
-- Phase 1 of docs/brain/specs/order-now-verify-nothing-due-verdict-for-skipped-spent-cycle.md
-- (owner: cs — ticket-derived product fix; ticket dd5e2ba0 — Ashley Denson).
--
-- The async commerce-order-now-verify Inngest job gains a 'nothing_due' verdict for an
-- order-now that the shopcx/internal renewal-attempt pipeline resolved against an
-- already-billed / not-yet-due cycle (no charge, no new order). That terminal verdict stamps
-- ticket_resolution_events.verified_outcome='nothing_due' — a distinguishable, truthful
-- "no charge, nothing to ship now" state that used to loop on 'unknown' and terminate as a
-- stale 'drifted'. The CHECK (added in 20260917120004 + widened in 20260707120001) must
-- permit the new value or the stamp's UPDATE fails and the ledger row stays open.
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
      CHECK (verified_outcome IS NULL OR verified_outcome IN ('confirmed','unbacked','drifted','clarified','nothing_due'));
  END IF;
END $$;
