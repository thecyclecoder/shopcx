-- Add shipping address and original Shopify creation date to subscriptions
-- Populated from Appstle subscription.created/updated webhooks

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS shipping_address JSONB;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS subscription_created_at TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.shipping_address IS 'Delivery address from Shopify subscription contract (deliveryMethod.address)';
COMMENT ON COLUMN subscriptions.subscription_created_at IS 'Original Shopify subscription creation date (not our DB insert date)';
