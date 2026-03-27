-- Meta social integration columns on workspaces
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_page_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_page_access_token_encrypted TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_instagram_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_webhook_verify_token TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_page_name TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS meta_oauth_state TEXT;

-- Meta fields on tickets for threading
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS meta_sender_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS meta_comment_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS meta_post_id TEXT;

-- Meta message ID on ticket_messages
ALTER TABLE ticket_messages ADD COLUMN IF NOT EXISTS meta_message_id TEXT;
