-- Slack integration: workspace connection + user mapping + notification rules

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_bot_token_encrypted text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_team_id text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_team_name text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_connected_at timestamptz;

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS slack_user_id text;

CREATE TABLE IF NOT EXISTS slack_notification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  event_type text NOT NULL,
  channel_id text,
  channel_name text,
  dm_assigned_agent boolean NOT NULL DEFAULT false,
  dm_admins boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(workspace_id, event_type)
);

ALTER TABLE slack_notification_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "workspace_read" ON slack_notification_rules FOR SELECT USING (
    workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "service_role_all" ON slack_notification_rules FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
