-- Appstle integration credentials
ALTER TABLE public.workspaces
  ADD COLUMN appstle_webhook_secret_encrypted TEXT,
  ADD COLUMN appstle_api_key_encrypted TEXT;
