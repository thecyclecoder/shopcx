-- pre_renewal_reminders — previewed_amount_cents (spec: renewal-reminder-launch-readiness
-- Phase 2 · [[../../docs/brain/tables/pre_renewal_reminders]]).
--
-- The reminder now states the EXACT amount the renewal will charge (CEO requirement,
-- 2026-11-17), resolved from the SAME pricing the renewal charge uses. We stamp that
-- previewed amount on the ledger row so a later mismatch with the actual renewal charge
-- can be audited. Nullable: null when the amount could not be resolved exactly (the
-- reminder then omits the amount rather than guessing).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (CLAUDE.md idempotent-SQL-migration rail).

ALTER TABLE public.pre_renewal_reminders
  ADD COLUMN IF NOT EXISTS previewed_amount_cents integer;
