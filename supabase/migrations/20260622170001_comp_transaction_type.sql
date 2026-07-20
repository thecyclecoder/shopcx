-- Comp transaction type constraint fix.
--
-- The comp-subscriptions build (20260620190000) writes ledger rows with
-- type='comp' from internal-subscription-renewals.ts, but transactions.type
-- is guarded by an inline CHECK (transactions_type_check, defined in
-- 20260520160000_transactions.sql) that only admits the original four values
-- — so every comp insert violates the constraint and, because the inserts
-- didn't check the returned error, the violation was silently swallowed.
--
-- transactions.type is TEXT + CHECK, not a pg enum, so widening it is a clean
-- one-shot drop-then-add — no ALTER TYPE. Widening (adding 'comp' to the IN
-- set) can never reject a row that previously passed; existing
-- initial_checkout/renewal/dunning_retry/manual rows are unaffected. Both
-- statements run in the migration's implicit transaction.

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('initial_checkout', 'renewal', 'dunning_retry', 'manual', 'comp'));
