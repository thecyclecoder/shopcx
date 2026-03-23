-- Add integration credentials to workspaces (encrypted at app layer)
ALTER TABLE public.workspaces
  ADD COLUMN resend_api_key_encrypted TEXT,
  ADD COLUMN resend_domain TEXT;
