-- Amplifier import reliability rail — Phase 1: durable failure state on the order.
-- A failed createAmplifierOrder call was only console.warn'd; there was no
-- queryable trace an operator or a reconcile sweep could act on. These three
-- columns are the substrate for the Phase 2 sweep and the Phase 3 escalation.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS amplifier_import_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amplifier_last_error TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_last_attempt_at TIMESTAMPTZ;
