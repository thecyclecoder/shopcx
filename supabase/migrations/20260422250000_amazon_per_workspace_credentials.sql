-- Store Amazon SP-API client_id and client_secret per workspace (not env vars)
-- Matches Shoptics approach for multi-tenant

ALTER TABLE public.amazon_connections ADD COLUMN IF NOT EXISTS client_id_encrypted TEXT;
ALTER TABLE public.amazon_connections ADD COLUMN IF NOT EXISTS client_secret_encrypted TEXT;
