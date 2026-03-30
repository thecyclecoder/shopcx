-- Add 'applied' status to loyalty_redemptions
-- Lifecycle: active → applied (on subscription) → used (order placed) or expired
-- When a coupon is removed from a subscription, status reverts to 'active'

COMMENT ON COLUMN loyalty_redemptions.status IS 'active=ready, applied=on subscription waiting for charge, used=consumed on order, expired=past expiry';
