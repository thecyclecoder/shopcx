-- Shopify OAuth columns
ALTER TABLE public.workspaces
  ADD COLUMN shopify_client_id_encrypted TEXT,
  ADD COLUMN shopify_client_secret_encrypted TEXT,
  ADD COLUMN shopify_myshopify_domain TEXT,
  ADD COLUMN shopify_oauth_state TEXT,
  ADD COLUMN shopify_scopes TEXT;
