-- Toggle for chat ticket creation (separate from widget_enabled)
-- widget_enabled = widget loads on site (KB articles always available)
-- chat_ticket_creation = whether customers can send messages / create tickets
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS chat_ticket_creation BOOLEAN NOT NULL DEFAULT true;
