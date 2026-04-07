-- Scope ticket views to individual users (not shared across workspace)
ALTER TABLE ticket_views ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- Backfill: set user_id from created_by for existing views
UPDATE ticket_views SET user_id = created_by WHERE user_id IS NULL AND created_by IS NOT NULL;

-- Index for per-user queries
CREATE INDEX IF NOT EXISTS idx_ticket_views_user ON ticket_views(workspace_id, user_id, sort_order);
