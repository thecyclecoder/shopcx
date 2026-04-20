-- Versium REACH API key storage
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS versium_api_key_encrypted TEXT;

-- Versium-sourced demographic fields on customer_demographics
ALTER TABLE public.customer_demographics
  ADD COLUMN IF NOT EXISTS versium_gender TEXT,
  ADD COLUMN IF NOT EXISTS versium_age_range TEXT,
  ADD COLUMN IF NOT EXISTS versium_household_income TEXT,
  ADD COLUMN IF NOT EXISTS versium_net_worth TEXT,
  ADD COLUMN IF NOT EXISTS versium_education TEXT,
  ADD COLUMN IF NOT EXISTS versium_marital_status TEXT,
  ADD COLUMN IF NOT EXISTS versium_home_owner BOOLEAN,
  ADD COLUMN IF NOT EXISTS versium_home_value TEXT,
  ADD COLUMN IF NOT EXISTS versium_household_size TEXT,
  ADD COLUMN IF NOT EXISTS versium_presence_of_children TEXT,
  ADD COLUMN IF NOT EXISTS versium_interests TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS versium_raw JSONB,
  ADD COLUMN IF NOT EXISTS versium_enriched_at TIMESTAMPTZ;
