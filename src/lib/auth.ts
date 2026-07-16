// db-load-auth-cache: per-request React cache() dedup of Supabase auth +
// workspace_members reads. One render → one auth resolve + one workspace_members
// read per userId, instead of 2–3 auths and 3 member reads (dashboard layout +
// getActiveWorkspaceId + getUserWorkspaces).
//
// db-load-getclaims: prefer local JWT verification (getClaims) over the GoTrue
// round-trip getUser(). On asymmetric signing keys getClaims verifies against a
// once-fetched, in-memory-cached JWKS — zero auth-table reads. On legacy HS256
// keys getClaims internally falls back to getUser() → identical behavior, safe
// to ship before the key migration. The Phase 1 accessor's callers (dashboard
// layout + workspace helpers) automatically inherit the local-verify path.
import { cache } from "react";
import type { AuthError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type ClaimsUser = {
  id: string;
  email: string | undefined;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
};

export const getAuthedUser = cache(
  async (): Promise<{ user: ClaimsUser | null; error: AuthError | null }> => {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (!data?.claims) return { user: null, error: error ?? null };
    const c = data.claims;
    return {
      user: {
        id: c.sub,
        email: c.email,
        app_metadata: c.app_metadata ?? {},
        user_metadata: c.user_metadata ?? {},
      },
      error: null,
    };
  }
);

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
