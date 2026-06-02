-- The previous migration (20260602210000_meta_ad_creative_jit) added
-- workspaces.meta_ad_accounts JSONB, but a proper relational table
-- `meta_ad_accounts` already existed (since 2026-05-18) — populated
-- by the OAuth callback with name/account_status/sync_enabled per row.
-- Drop the duplicate JSONB column; the ingest path reads from the
-- relational table instead.
ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS meta_ad_accounts;
