// db-load-auth-cache: per-request React cache() dedup of Supabase auth +
// workspace_members reads. One render → one auth resolve + one workspace_members
// read per userId, instead of 2–3 auths and 3 member reads (dashboard layout +
// getActiveWorkspaceId + getUserWorkspaces).
//
// Phase 3 / Fix 1 — this accessor stays on supabase.auth.getUser() (fresh
// server-side validation), NOT getClaims(), because its two callers are authz
// gates: src/app/dashboard/layout.tsx (login gate for protected dashboard SSR)
// and src/lib/workspace.ts getActiveWorkspaceId (its app_metadata.workspace_id
// fallback drives service-role dashboard reads — see e.g.
// src/app/dashboard/storefront/blog/page.tsx:39). A local-verify path would
// accept a signed-but-revoked JWT until natural expiry — the pre-merge
// spec-test flagged this as an authz regression on the [check
// blocker:real_blocker] check. Phase 2's getClaims swap is retained at the
// middleware site (src/lib/supabase/middleware.ts) where the gate is coarse
// ("logged in? redirect to /login" + ADMIN_EMAIL) and the fine-grained authz
// happens downstream in this accessor.
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
