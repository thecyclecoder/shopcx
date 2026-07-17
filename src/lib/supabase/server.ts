import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  );
}

export type AuthedUser = {
  id: string;
  email: string | null;
  app_metadata: Record<string, any>;
  user_metadata: Record<string, any>;
};

// db-load-route-auth-helper: the single auth entrypoint for API-route handlers
// under src/app/api/**/route.ts. Calls createClient() then supabase.auth.getClaims(),
// which verifies the JWT locally against the project's asymmetric ECC signing keys
// (JWKS cached in-process) — zero auth-table reads per request. Falls back to
// getUser() internally on legacy HS256 keys, so the helper is regression-safe
// pre-migration. Returns { user } in the same shape routes already read via
// `const { data: { user } } = await supabase.auth.getUser()`, so the codemod is
// a mechanical `const { user } = await getAuthedUser()` swap. Any route that
// needs a field NOT in JwtPayload (email, app_metadata, user_metadata are
// present; sensitive fields like phone_confirmed_at are not) should call
// getAuthedUser({ fresh: true }) to fall back to the server-side getUser() path.
export async function getAuthedUser(opts?: {
  fresh?: boolean;
}): Promise<{ user: AuthedUser | null }> {
  const supabase = await createClient();
  if (opts?.fresh) {
    const { data } = await supabase.auth.getUser();
    const u = data.user;
    if (!u) return { user: null };
    return {
      user: {
        id: u.id,
        email: u.email ?? null,
        app_metadata: u.app_metadata ?? {},
        user_metadata: u.user_metadata ?? {},
      },
    };
  }
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims ?? null;
  if (!claims) return { user: null };
  return {
    user: {
      id: claims.sub,
      email: claims.email ?? null,
      app_metadata: claims.app_metadata ?? {},
      user_metadata: claims.user_metadata ?? {},
    },
  };
}
