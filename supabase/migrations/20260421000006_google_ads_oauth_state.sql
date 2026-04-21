ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS google_ads_oauth_state TEXT;
