-- cancelled-subs-stop-reporting-a-future-billing-date Phase 1: give
-- subscriptions a first-class cancel timestamp so a cancelled row can no
-- longer claim a future charge date, and 'when was this cancelled?' is
-- answerable off the row itself instead of a billing_forecast_events probe.
--
-- Why: On ticket f773b8ec (bonnie marlette, 2026-08-21) the CS Director read
-- a cancelled subscription whose next_billing_date still pointed at
-- 2026-09-11, concluded the contract was live, and escalated a $209.13
-- 'post-cancellation renewals' refund to the founder. The forecast events
-- ledger recorded the cancel at 2026-07-17T08:39:51 — 36 minutes AFTER the
-- last renewal billed. The field lied and the agent believed it. Both cancel
-- writers will now stamp cancelled_at and clear next_billing_date in the
-- same update that sets status='cancelled'.
--
-- Nullable + IF NOT EXISTS — idempotent and safe on already-cancelled rows;
-- Phase 2 backfills historical values from the forecast-events ledger.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
