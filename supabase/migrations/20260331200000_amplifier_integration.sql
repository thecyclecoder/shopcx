-- Amplifier 3PL integration columns on workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS amplifier_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS amplifier_order_source_code TEXT;
