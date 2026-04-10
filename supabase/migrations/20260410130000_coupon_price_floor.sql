-- Minimum price floor for sale coupons on grandfathered pricing (% of MSRP)
-- Default 50 = customer can never pay below 50% of standard price with a sale coupon
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS coupon_price_floor_pct integer DEFAULT 50;
