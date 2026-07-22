-- payment_failures.result — a proper lifecycle status for a billing attempt.
--
-- The legacy Appstle dunning logs a row the moment a billing attempt is
-- SUBMITTED (succeeded=false, null error_code, "Billing attempt accepted by
-- Appstle"); the real outcome arrives later via the billing-failure /
-- billing-success webhook. With only a `succeeded` boolean, a submitted-but-
-- pending attempt was indistinguishable from a decline — inflating failure
-- counts in analytics, the AI's get_dunning_status, and the portal.
--
-- `result` separates the three real states. Going forward the webhook RESOLVES
-- the pending row (by billing_attempt_id) to 'failed' / 'succeeded' instead of
-- inserting a duplicate. `succeeded` is kept for back-compat.
ALTER TABLE public.payment_failures
  ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'failed';

DO $$ BEGIN
  ALTER TABLE public.payment_failures
    ADD CONSTRAINT payment_failures_result_check
    CHECK (result IN ('pending', 'failed', 'succeeded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill existing rows.
UPDATE public.payment_failures SET result = 'succeeded' WHERE succeeded = true AND result <> 'succeeded';
UPDATE public.payment_failures
  SET result = 'pending'
  WHERE succeeded = false
    AND error_code IS NULL
    AND error_message ILIKE '%accepted%'
    AND result <> 'pending';
-- Everything else keeps the 'failed' default.

CREATE INDEX IF NOT EXISTS payment_failures_result_idx
  ON public.payment_failures (workspace_id, result, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_failures_attempt_result_idx
  ON public.payment_failures (billing_attempt_id, result) WHERE billing_attempt_id IS NOT NULL;
