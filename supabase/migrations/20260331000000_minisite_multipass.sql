-- Minisite routing + Multipass auth

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS shopify_multipass_secret_encrypted text;
