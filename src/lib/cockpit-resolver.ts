/**
 * cockpit-resolver — the SINGLE chokepoint the /god/[token] routes call to decide
 * WHICH cockpit backs a 48-hex token.
 *
 * Two disjoint token spaces feed one URL surface:
 *   • god_mode_sessions.cockpit_token  → { kind:'god', session } — Eve's cockpit
 *   • director_coach_threads.cockpit_token → { kind:'director', thread } — a per-director
 *     SMS cockpit ([[../../docs/brain/specs/director-sms-cockpit-per-director.md]] Phase 1)
 *
 * A token that resolves in one table CANNOT resolve in the other (the unique-per-token
 * index on each side + the disjoint mint helpers guarantee it). We deliberately hit
 * god_mode_sessions FIRST so the pre-existing Eve cockpit path stays unchanged for
 * every existing token — the director branch is additive.
 *
 * Rejection modes are collapsed into ONE terminal `null`:
 *   • wrong-length or empty token → null (before any DB call)
 *   • token unknown in both tables → null
 *   • token found but past sliding OR absolute TTL → null
 *   • token found but the god session is not 'armed' → null
 *
 * The /god/[token] route MUST branch on the returned `kind` (never assume god).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCockpitToken, type GodModeSessionRow } from "@/lib/god-mode";
import {
  resolveDirectorCockpitToken,
  type DirectorCoachThread,
} from "@/lib/agents/director-coach-threads";

export type CockpitResolution =
  | { kind: "god"; session: GodModeSessionRow }
  | { kind: "director"; thread: DirectorCoachThread };

/**
 * Resolve a 48-hex cockpit token to its backing surface (god | director) or null.
 *
 * Order matters: we check god_mode_sessions first so Eve's cockpit path is BYTE-FOR-
 * BYTE unchanged for every already-armed session. Only when god returns not-found do
 * we fall through to director_coach_threads.
 */
export async function resolveCockpitTokenAny(
  admin: SupabaseClient,
  token: string,
): Promise<CockpitResolution | null> {
  if (!token || token.length !== 48) return null;

  const god = await resolveCockpitToken(admin, token);
  if (god.kind === "ok") return { kind: "god", session: god.session };

  const director = await resolveDirectorCockpitToken(token);
  if (director) return { kind: "director", thread: director };

  return null;
}
