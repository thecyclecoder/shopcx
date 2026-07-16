// db-load-auth-cache: per-request React cache() dedup of Supabase getUser() +
// workspace_members reads. One render → one GoTrue getUser() (5 auth-table reads)
// + one workspace_members read per userId, instead of 2-3 auths and 3 member reads
// (dashboard layout + getActiveWorkspaceId + getUserWorkspaces).
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const getAuthedUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return { user: data.user, error };
});

export type WorkspaceMembership = {
  workspace_id: string;
  role: string;
};

export const getWorkspaceMemberships = cache(
  async (userId: string): Promise<WorkspaceMembership[]> => {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", userId);
    if (error || !data) return [];
    return data;
  }
);
