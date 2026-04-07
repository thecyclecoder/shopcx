-- Store EasyPost tracking data on orders for richer delivery info
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS easypost_status TEXT,
  ADD COLUMN IF NOT EXISTS easypost_detail TEXT,
  ADD COLUMN IF NOT EXISTS easypost_location TEXT,
  ADD COLUMN IF NOT EXISTS easypost_checked_at TIMESTAMPTZ;
