-- Enable RLS
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invites ENABLE ROW LEVEL SECURITY;

-- Workspaces: users can view workspaces they belong to
CREATE POLICY "Users can view their workspaces"
  ON public.workspaces FOR SELECT TO authenticated
  USING (
    id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );

-- Workspaces: service role can do everything
CREATE POLICY "Service role full access on workspaces"
  ON public.workspaces FOR ALL
  USING (auth.role() = 'service_role');

-- Members: users can view members of workspaces they belong to
CREATE POLICY "Users can view workspace members"
  ON public.workspace_members FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM public.workspace_members wm WHERE wm.user_id = auth.uid())
  );

-- Members: service role full access
CREATE POLICY "Service role full access on members"
  ON public.workspace_members FOR ALL
  USING (auth.role() = 'service_role');

-- Invites: viewable by workspace members
CREATE POLICY "Members can view invites"
  ON public.workspace_invites FOR SELECT TO authenticated
  USING (
    workspace_id IN (SELECT wm.workspace_id FROM public.workspace_members wm WHERE wm.user_id = auth.uid())
  );

-- Invites: service role full access
CREATE POLICY "Service role full access on invites"
  ON public.workspace_invites FOR ALL
  USING (auth.role() = 'service_role');

-- Grant workspace_members read to the JWT hook function
GRANT SELECT ON public.workspace_members TO supabase_auth_admin;
