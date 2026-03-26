-- Unique help center slug per workspace for public mini-site
-- e.g. "superfoods" → superfoods.shopcx.ai or /help/superfoods
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS help_slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_help_slug ON public.workspaces(help_slug) WHERE help_slug IS NOT NULL;
