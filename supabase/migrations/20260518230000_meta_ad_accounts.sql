-- Per-workspace registry of Meta ad accounts the user has access to.
-- Auto-populated from /me/adaccounts on Meta connect/reconnect; admin
-- toggles which accounts the historical-comments backfill should pull
-- from at Settings → Integrations → Meta.

CREATE TABLE IF NOT EXISTS meta_ad_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fb_act_id         TEXT NOT NULL,            -- "act_711609716022670"
  name              TEXT,
  account_status    INTEGER,                  -- 1=active, 2=disabled, 3=unsettled, 7=pending review, 101=closed, 102=any active, 201=pending settlement
  sync_enabled      BOOLEAN NOT NULL DEFAULT false,
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_ad_accounts_workspace_act_key UNIQUE (workspace_id, fb_act_id)
);

CREATE INDEX IF NOT EXISTS meta_ad_accounts_workspace_idx
  ON meta_ad_accounts (workspace_id);

ALTER TABLE meta_ad_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON meta_ad_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
