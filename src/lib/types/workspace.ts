export type WorkspacePlan = "free" | "starter" | "pro" | "enterprise";
export type WorkspaceRole = "owner" | "admin" | "agent" | "social" | "marketing" | "read_only";

export interface Workspace {
  id: string;
  name: string;
  shopify_domain: string | null;
  meta_page_id: string | null;
  stripe_account_id: string | null;
  plan: WorkspacePlan;
  created_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  // Joined fields
  email?: string;
  display_name?: string;
}

export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  invited_by: string;
  accepted_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface WorkspaceWithRole extends Workspace {
  role: WorkspaceRole;
}
