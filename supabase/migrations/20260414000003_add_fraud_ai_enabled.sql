ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS fraud_ai_enabled BOOLEAN DEFAULT false;
