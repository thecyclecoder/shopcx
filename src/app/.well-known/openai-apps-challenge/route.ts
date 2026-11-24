/**
 * OpenAI Apps domain-verification endpoint (docs/brain/recipes/list-ai-shopping-agent.md · Phase 4).
 *
 * Serves `/.well-known/openai-apps-challenge` with the per-workspace verification token so OpenAI can
 * confirm ownership of the storefront domain (a prerequisite for the ChatGPT apps directory listing).
 * The path constant + token resolution live in the visible lib
 * `src/lib/shopping-agent/openai-apps-challenge.ts` (this route folder is a dotdir); the token is
 * served as text/plain. It is NOT a secret — it is meant to be fetched openly here.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { hostFromRequest, resolveOpenAiAppsChallengeToken } from "@/lib/shopping-agent/openai-apps-challenge";

export async function GET(request: Request) {
  const admin = createAdminClient();
  const token = await resolveOpenAiAppsChallengeToken(admin, hostFromRequest(request));
  if (!token) {
    return new Response("not configured", { status: 404, headers: { "content-type": "text/plain" } });
  }
  return new Response(token, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
