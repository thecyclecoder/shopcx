import { createAdminClient } from "@/lib/supabase/admin";

const ADMIN_EMAIL = "dylan@superfoodscompany.com";

export function isAdminEmail(email: string): boolean {
  return email.toLowerCase() === ADMIN_EMAIL;
}

export async function isAuthorizedUser(email: string): Promise<boolean> {
  // Admin always has access
  if (isAdminEmail(email)) return true;

  const admin = createAdminClient();

  // Check if this email has a pending or accepted invite
  const { data: invites } = await admin
    .from("workspace_invites")
    .select("id")
    .eq("email", email.toLowerCase())
    .limit(1);

  if (invites && invites.length > 0) return true;

  // Check if they're already a member of any workspace (previously accepted invite).
  // Targeted lookup — the previous full-page auth.users scan silently paginated at 50
  // rows and dropped every user whose id sorted past that page. RPC returns the one id
  // we need, then getUserById verifies the user still exists (null/not-found → denied).
  const { data: matchedUserId } = await admin.rpc("get_user_id_by_email", {
    p_email: email.toLowerCase(),
  });
  if (!matchedUserId) return false;

  const { data: { user } } = await admin.auth.admin.getUserById(matchedUserId as string);
  if (!user) return false;

  const { data: memberships } = await admin
    .from("workspace_members")
    .select("id")
    .eq("user_id", user.id)
    .limit(1);

  return !!(memberships && memberships.length > 0);
}

export async function isAuthorizedUserId(userId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Get user email
  const { data: { user } } = await admin.auth.admin.getUserById(userId);
  if (!user?.email) return false;

  return isAuthorizedUser(user.email);
}
