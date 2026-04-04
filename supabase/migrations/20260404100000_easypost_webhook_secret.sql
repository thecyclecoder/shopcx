-- EasyPost webhook secret for HMAC verification
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS easypost_webhook_secret TEXT;
