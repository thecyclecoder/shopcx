-- Phase 1 of crisis-resolve-ships-promised-restock-replacements.
--
-- Support sometimes promises a customer WITHOUT a subscription (e.g. Peggy,
-- customer 0897b4e5) that we'll send their out-of-stock flavor once it is
-- restocked. Resolving a crisis today only touches subscriptions, so those
-- promises live only as snoozed tickets a human has to remember. We record the
-- promise structurally against the crisis instead, reusing public.replacements
-- (it already carries customer_id / ticket_id / items / status) so no new
-- customer_id table is needed.
--
-- This migration:
--   1. adds replacements.crisis_id -> crisis_events(id) so a promise can be
--      found when its crisis resolves, and
--   2. allows the new status value 'awaiting_restock'.
--
-- replacements.status is a plain TEXT column with no CHECK constraint today
-- (see 20260407100000_replacements.sql), so no constraint needs widening; the
-- column already accepts 'awaiting_restock'. The guarded DO block below drops
-- and re-adds a status CHECK only if one was ever introduced, so this stays
-- correct even if a later migration pins the status vocabulary. Idempotent.

ALTER TABLE public.replacements
  ADD COLUMN IF NOT EXISTS crisis_id UUID REFERENCES public.crisis_events(id);

CREATE INDEX IF NOT EXISTS idx_replacements_crisis ON public.replacements(crisis_id);

-- If a status CHECK constraint exists, widen it to include 'awaiting_restock'.
-- No-op on the current schema (status is unconstrained TEXT).
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT c.conname INTO con_name
  FROM pg_constraint c
  WHERE c.conrelid = 'public.replacements'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.replacements DROP CONSTRAINT %I', con_name);
    ALTER TABLE public.replacements
      ADD CONSTRAINT replacements_status_check CHECK (status IN (
        'pending', 'address_confirmed', 'created', 'shipped',
        'completed', 'failed', 'denied', 'superseded', 'awaiting_restock'
      ));
  END IF;
END $$;

COMMENT ON COLUMN public.replacements.crisis_id IS
  'When set, this replacement is a restock promise recorded against a crisis_events row. status=awaiting_restock rows ship automatically when the crisis is resolved.';
