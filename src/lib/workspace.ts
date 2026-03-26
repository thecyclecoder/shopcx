import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import type { WorkspaceWithRole } from "@/lib/types/workspace";

const WORKSPACE_COOKIE = "workspace_id";

export async function getUserWorkspaces(userId: string): Promise<WorkspaceWithRole[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspace_members")
    .select("role, workspaces(*)")
    .eq("user_id", userId);

  if (error || !data) return [];

  return data.map((row) => ({
    ...(row.workspaces as unknown as WorkspaceWithRole),
    role: row.role,
  }));
}

export async function setActiveWorkspace(userId: string, workspaceId: string) {
  const admin = createAdminClient();

  // Verify membership
  const { data: member } = await admin
    .from("workspace_members")
    .select("id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!member) throw new Error("Not a member of this workspace");

  // Update app_metadata so the JWT hook picks it up
  await admin.auth.admin.updateUserById(userId, {
    app_metadata: { workspace_id: workspaceId },
  });

  // Set cookie for middleware
  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function getActiveWorkspaceId(): Promise<string | null> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(WORKSPACE_COOKIE)?.value;
  if (fromCookie) return fromCookie;

  // Fallback: check user's app_metadata (survives cookie loss in PWA)
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const wsId = user.app_metadata?.workspace_id;
  if (wsId) {
    // Re-set the cookie so subsequent requests don't need this fallback
    cookieStore.set(WORKSPACE_COOKIE, wsId, {
      path: "/",
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    return wsId;
  }

  // Last resort: if user has exactly 1 workspace, auto-select it
  const admin = createAdminClient();
  const { data: memberships } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id);

  if (memberships?.length === 1) {
    const autoId = memberships[0].workspace_id;
    // Set app_metadata + cookie
    await admin.auth.admin.updateUserById(user.id, {
      app_metadata: { workspace_id: autoId },
    });
    cookieStore.set(WORKSPACE_COOKIE, autoId, {
      path: "/",
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
    return autoId;
  }

  return null;
}

export async function autoAcceptInvites(userId: string, email: string) {
  const admin = createAdminClient();

  const { data: invites } = await admin
    .from("workspace_invites")
    .select("*")
    .eq("email", email.toLowerCase())
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString());

  if (!invites?.length) return;

  for (const invite of invites) {
    // Create membership
    await admin.from("workspace_members").upsert(
      {
        workspace_id: invite.workspace_id,
        user_id: userId,
        role: invite.role,
      },
      { onConflict: "workspace_id,user_id" }
    );

    // Mark invite accepted
    await admin
      .from("workspace_invites")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invite.id);
  }
}
