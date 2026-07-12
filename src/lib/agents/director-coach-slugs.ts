/**
 * Directors that have a working coach-thread backend (a `<slug>-director.ts` leash module +
 * a `director-leash-guide.ts` entry). Pure-config + client-safe: [[../../app/dashboard/agents/[role]/page.tsx]]
 * imports `hasCoachThread` to gate the Coach section without pulling in the server-only
 * director modules (each `*-director.ts` imports supabase/admin), so this list is the
 * single source of truth for "which directors can back a coach conversation."
 *
 * Kept in lock-step with `DIRECTOR_LEASH` in [[director-leash-guide]] — the guide's server-side
 * runtime assertion (see director-leash-guide.ts) throws on divergence, so a slug added there
 * but missing here (or vice-versa) fails fast at import time.
 *
 * See docs/brain/specs/generalize-director-coach-backend.md (Phase 3).
 */

export const COACH_THREAD_SLUGS = ["platform", "growth", "cs"] as const;

export type CoachThreadSlug = (typeof COACH_THREAD_SLUGS)[number];

const COACH_THREAD_SET: Set<string> = new Set(COACH_THREAD_SLUGS);

/** true iff `slug` has a leash module + can back a resumable coach thread. */
export function hasCoachThread(slug: string): boolean {
  return COACH_THREAD_SET.has(slug);
}
