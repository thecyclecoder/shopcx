-- Phase 3 of fraud-bin-velocity-requires-real-cross-account-link.
--
-- Confirming fraud is a PER-CUSTOMER action: when Zach confirms a named
-- customer, only that customer's subs are cancelled, their orders refunded,
-- and they are banned — never the whole case. `confirmed_customer_ids` is the
-- authoritative record of which members of a case have actually been confirmed
-- as fraud. Readers (customer-fraud-status, commerce/fraud, the orchestrator,
-- the repeat-offender similarity check) treat a confirmed_fraud case as
-- counting for a customer ONLY when that customer appears in this array.
--
-- Idempotent backfill: for existing status='confirmed_fraud' rows with an empty
-- confirmed_customer_ids, seed it from customer_ids so history behaves exactly
-- as before (the whole case was confirmed under the old case-wide contract).
-- The BIN 414740 reversal removes the 8 innocent customers separately — this
-- migration is deliberately behavior-preserving.

ALTER TABLE public.fraud_cases
  ADD COLUMN IF NOT EXISTS confirmed_customer_ids uuid[] NOT NULL DEFAULT '{}';

UPDATE public.fraud_cases
SET confirmed_customer_ids = customer_ids
WHERE status = 'confirmed_fraud'
  AND (confirmed_customer_ids IS NULL OR confirmed_customer_ids = '{}')
  AND customer_ids IS NOT NULL
  AND customer_ids <> '{}';
