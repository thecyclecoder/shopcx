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

  // Check if they're already a member of any workspace (previously accepted invite)
  const { data: { users } } = await admin.auth.admin.listUsers();
  const matchedUser = users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());

  if (matchedUser) {
    const { data: memberships } = await admin
      .from("workspace_members")
      .select("id")
      .eq("user_id", matchedUser.id)
      .limit(1);

    if (memberships && memberships.length > 0) return true;
  }

  return false;
}

export async function isAuthorizedUserId(userId: string): Promise<boolean> {
  const admin = createAdminClient();

  // Get user email
  const { data: { user } } = await admin.auth.admin.getUserById(userId);
  if (!user?.email) return false;

  return isAuthorizedUser(user.email);
}
