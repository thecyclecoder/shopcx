-- Add static (immutable) columns to billing_forecasts
-- static_revenue_cents and static_date are set at creation and never updated
-- Used for the "Static" column in MRR analytics (original forecast before any changes)

ALTER TABLE billing_forecasts
  ADD COLUMN IF NOT EXISTS static_revenue_cents INTEGER,
  ADD COLUMN IF NOT EXISTS static_date DATE;

-- Backfill: for existing rows, use current expected values as static
-- (we can't recover the original values, so current is the best approximation)
-- For rows with previous_revenue_cents, use that as the original
UPDATE billing_forecasts
SET
  static_revenue_cents = COALESCE(previous_revenue_cents, expected_revenue_cents),
  static_date = COALESCE(previous_date, expected_date)
WHERE static_revenue_cents IS NULL;
