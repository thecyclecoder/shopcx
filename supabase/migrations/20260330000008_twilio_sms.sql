-- Only the phone number is per-workspace, Twilio credentials are global env vars
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_twilio_phone ON workspaces(twilio_phone_number) WHERE twilio_phone_number IS NOT NULL;
