-- Braintree credentials per workspace
--
-- Mirrors how Shopify/Appstle/Klaviyo creds are stored: plaintext for
-- public identifiers, AES-256-GCM encrypted for the secret half. The
-- environment column lets a workspace flip between sandbox and prod
-- without touching the secrets.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS braintree_merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS braintree_public_key TEXT,
  ADD COLUMN IF NOT EXISTS braintree_private_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS braintree_environment TEXT NOT NULL DEFAULT 'production'
    CHECK (braintree_environment IN ('production', 'sandbox'));
