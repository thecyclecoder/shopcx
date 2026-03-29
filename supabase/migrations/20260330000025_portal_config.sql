-- Portal configuration per workspace
-- Stores general portal settings, Shopify extension config, and mini-site config

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS portal_config JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN workspaces.portal_config IS 'Portal settings: general (lock_days, products, selling_plans), shopify (proxy_path), minisite (domain, branding, auth)';
