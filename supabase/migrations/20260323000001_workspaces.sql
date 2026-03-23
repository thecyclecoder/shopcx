-- Phase 1: Workspace, Auth & Multi-Tenancy

-- Enums
CREATE TYPE public.workspace_plan AS ENUM ('free', 'starter', 'pro', 'enterprise');
CREATE TYPE public.workspace_role AS ENUM ('owner', 'admin', 'agent', 'social', 'marketing', 'read_only');

-- Workspaces
CREATE TABLE public.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  shopify_domain TEXT,
  shopify_access_token_encrypted TEXT,
  meta_page_id TEXT,
  stripe_account_id TEXT,
  plan public.workspace_plan NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workspace members
CREATE TABLE public.workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.workspace_role NOT NULL DEFAULT 'read_only',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);

-- Workspace invites
CREATE TABLE public.workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role public.workspace_role NOT NULL DEFAULT 'agent',
  invited_by UUID NOT NULL REFERENCES auth.users(id),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_workspace_members_user ON public.workspace_members(user_id);
CREATE INDEX idx_workspace_members_workspace ON public.workspace_members(workspace_id);
CREATE INDEX idx_workspace_invites_email ON public.workspace_invites(email);
CREATE INDEX idx_workspace_invites_workspace ON public.workspace_invites(workspace_id);
