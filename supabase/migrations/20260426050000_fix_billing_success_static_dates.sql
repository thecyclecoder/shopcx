-- Retroactive fix for the MRR static-column inflation bug.
--
-- forecastCollected used to create the next-cycle forecast with
-- nextBillingDate read from the subscription row, but the Appstle
-- billing-success webhook fires before the cascaded
-- next-order-date-changed webhook updates sub.next_billing_date.
-- Result: the next-cycle forecast was created with expected_date == the
-- just-collected date, then later got updated to the real next date via
-- forecastDateChanged — but its (immutable) static_date was already
-- locked to the wrong date, inflating "static" totals for past dates.
--
-- Fix: for any forecast created via billing_success where the static_date
-- still doesn't match the expected_date, sync them. These forecasts'
-- "original" date in any meaningful sense IS their current expected_date —
-- the date Appstle truly intends them to bill on.

UPDATE billing_forecasts
SET
  static_date = expected_date,
  static_revenue_cents = expected_revenue_cents
WHERE created_from = 'billing_success'
  AND static_date IS DISTINCT FROM expected_date;
