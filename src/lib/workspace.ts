import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import type { WorkspaceWithRole } from "@/lib/types/workspace";
import { getAuthedUser, getWorkspaceMemberships } from "@/lib/auth"; // db-load-auth-cache

const WORKSPACE_COOKIE = "workspace_id";

// db-load-auth-cache: cache()-wrapped so the dashboard layout render fires this once.
export const getUserWorkspaces = cache(
  async (userId: string): Promise<WorkspaceWithRole[]> => {
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
);

export async function setActiveWorkspace(userId: string, workspaceId: string) {
  const admin = createAdminClient();

  // Verify membership via cache()-wrapped resolver so a render that already
  // read workspace_members for this user doesn't re-hit it (db-load-auth-cache).
  const memberships = await getWorkspaceMemberships(userId);
  if (!memberships.some((m) => m.workspace_id === workspaceId)) {
    throw new Error("Not a member of this workspace");
  }

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

// db-load-auth-cache: cache()-wrapped so cookie-miss fallback (which calls getUser
// + workspace_members) doesn't fire more than once per render.
export const getActiveWorkspaceId = cache(async (): Promise<string | null> => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(WORKSPACE_COOKIE)?.value;
  if (fromCookie) return fromCookie;

  // Fallback: check user's app_metadata (survives cookie loss in PWA)
  const { user } = await getAuthedUser();
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

  // Last resort: if user has exactly 1 workspace, auto-select it. Uses the
  // cache()-wrapped resolver so a sibling caller in the same render reuses it.
  const memberships = await getWorkspaceMemberships(user.id);

  if (memberships.length === 1) {
    const autoId = memberships[0].workspace_id;
    // Set app_metadata + cookie
    const admin = createAdminClient();
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
});

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
