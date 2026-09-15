-- one_time_charges gains attempt_history — the ledger of prior attempts on a single charge row.
--
-- WHY. A failed one-time charge is terminal today: the row records the last error, the last
-- billing_attempt_id, the last rail, and nothing else. `retryOneTimeCharge` (this migration's
-- co-shipped code) re-drives the SAME row against a different `shopify_payment_method_id` rather
-- than creating a second row — which is what stops a double-bill if the first row is later
-- re-executed by hand — but doing that would OVERWRITE the record of the prior decline. This
-- column preserves each prior attempt so 'this card declined, that one is untried' is visible on
-- the row itself, without joining payment_failures / customer_events by hand.
--
-- SHAPE. jsonb array; each element is an object appended by `retryOneTimeCharge` immediately
-- before the retry claim reopens the row:
--   { payment_method_id, rail, error, billing_attempt_id, attempts_at_failure, failed_at }
-- payment_failures and customer_events remain the canonical decline ledgers — this is the
-- on-row breadcrumb for the human deciding which card to try next.
--
-- DEFAULT. Empty array so every existing row (all today's charges pre-migration) reads as
-- 'no prior attempts', which is the truthful history for a row that has never been retried.

ALTER TABLE public.one_time_charges
  ADD COLUMN IF NOT EXISTS attempt_history jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.one_time_charges.attempt_history IS
  'JSONB array of prior attempts on this charge row. Each entry is {payment_method_id, rail, error, billing_attempt_id, attempts_at_failure, failed_at}. Appended by retryOneTimeCharge before the row is reopened from failed to pending, so the human deciding which card to try next can see which methods have already declined without querying the payment provider.';
