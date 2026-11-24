/**
 * OpenAI Apps domain-verification helper (docs/brain/recipes/list-ai-shopping-agent.md · Phase 4).
 *
 * The verification token is served at the well-known path `/.well-known/openai-apps-challenge` by the
 * route `src/app/.well-known/openai-apps-challenge/route.ts`. That route folder is a dotdir, so this
 * VISIBLE lib owns the path constant + the per-workspace token resolution (single source of truth the
 * route imports). The token is NOT a secret — it is published at that path by design — so it is stored
 * plain in `workspaces.openai_apps_challenge_token`.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The well-known path OpenAI fetches to verify the storefront domain. */
export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

/** Normalize a request Host header to a bare hostname (strip port + leading www.). */
export function hostFromRequest(request: Request): string {
  const h = request.headers.get("host") || "";
  return h.split(":")[0].toLowerCase().replace(/^www\./, "");
}

/**
 * Resolve the verification token to serve for a request host. 1) match the host against a
 * workspace's `storefront_domain`; 2) fall back to the single workspace that has a token configured
 * (this storefront is single-tenant). Returns null when no token is set.
 */
export async function resolveOpenAiAppsChallengeToken(admin: Admin, host: string): Promise<string | null> {
  if (host) {
    const { data } = await admin
      .from("workspaces")
      .select("openai_apps_challenge_token, storefront_domain")
      .ilike("storefront_domain", host)
      .maybeSingle();
    const t = (data?.openai_apps_challenge_token as string | null) ?? null;
    if (t) return t;
  }
  const { data } = await admin
    .from("workspaces")
    .select("openai_apps_challenge_token")
    .not("openai_apps_challenge_token", "is", null)
    .limit(1)
    .maybeSingle();
  return (data?.openai_apps_challenge_token as string | null) ?? null;
}
