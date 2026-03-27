-- Live Chat Widget: sessions table + workspace settings

CREATE TABLE public.widget_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  email TEXT,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_activity_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_widget_sessions_workspace ON widget_sessions(workspace_id);
CREATE INDEX idx_widget_sessions_ticket ON widget_sessions(ticket_id);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_enabled BOOLEAN DEFAULT false;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_color TEXT DEFAULT '#4f46e5';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_greeting TEXT DEFAULT 'Hi! How can we help you today?';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS widget_position TEXT DEFAULT 'bottom-right';

-- RLS: service role only (widget API uses admin client)
ALTER TABLE widget_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on widget_sessions"
  ON widget_sessions FOR ALL
  USING (true)
  WITH CHECK (true);
