-- Configurable auto-close reply message per workspace
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS auto_close_reply TEXT DEFAULT 'You''re welcome! If you need anything else, we''re always here to help.';
