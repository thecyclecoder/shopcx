-- Editable display name per workspace member
ALTER TABLE public.workspace_members ADD COLUMN IF NOT EXISTS display_name TEXT;
