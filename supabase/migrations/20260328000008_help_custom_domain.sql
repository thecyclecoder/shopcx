-- Custom domain for help center (e.g. help.superfoodscompany.com)
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS help_custom_domain TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_help_custom_domain ON public.workspaces(help_custom_domain) WHERE help_custom_domain IS NOT NULL;
