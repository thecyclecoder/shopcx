-- Help center branding
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS help_logo_url TEXT;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS help_primary_color TEXT DEFAULT '#4f46e5';
