-- Fix static backfill: previous_date is not the original date, it's the date
-- before the LAST change. Using it inflated static counts.
-- Reset to expected_date — not perfect for changed forecasts, but consistent.
-- New forecasts get correct static values at creation going forward.

UPDATE billing_forecasts
SET
  static_revenue_cents = expected_revenue_cents,
  static_date = expected_date;
