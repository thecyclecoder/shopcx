-- Meta Ads integration for ROAS calculator

-- Meta OAuth connection (one per workspace)
CREATE TABLE public.meta_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  meta_user_id TEXT,
  meta_user_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id)
);

-- Selected Meta ad accounts
CREATE TABLE public.meta_ad_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meta_connection_id UUID NOT NULL REFERENCES public.meta_connections(id) ON DELETE CASCADE,
  meta_account_id TEXT NOT NULL, -- numeric ID (no "act_" prefix)
  meta_account_name TEXT NOT NULL,
  currency TEXT DEFAULT 'USD',
  timezone TEXT DEFAULT 'America/Chicago',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, meta_account_id)
);

-- Daily Meta ad spend snapshots (aggregated per account per day)
CREATE TABLE public.daily_meta_ad_spend (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meta_ad_account_id UUID NOT NULL REFERENCES public.meta_ad_accounts(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0,
  purchase_value_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(meta_ad_account_id, snapshot_date)
);

CREATE INDEX idx_meta_spend_date ON daily_meta_ad_spend(workspace_id, snapshot_date DESC);

-- RLS
ALTER TABLE public.meta_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_meta_ad_spend ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth read meta_connections" ON public.meta_connections FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full meta_connections" ON public.meta_connections FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Auth read meta_ad_accounts" ON public.meta_ad_accounts FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full meta_ad_accounts" ON public.meta_ad_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Auth read daily_meta_ad_spend" ON public.daily_meta_ad_spend FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full daily_meta_ad_spend" ON public.daily_meta_ad_spend FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON meta_connections TO service_role;
GRANT ALL ON meta_ad_accounts TO service_role;
GRANT ALL ON daily_meta_ad_spend TO service_role;
GRANT SELECT ON meta_connections TO authenticated;
GRANT SELECT ON meta_ad_accounts TO authenticated;
GRANT SELECT ON daily_meta_ad_spend TO authenticated;
