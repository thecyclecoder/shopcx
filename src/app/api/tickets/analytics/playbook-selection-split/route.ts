/**
 * /api/tickets/analytics/playbook-selection-split — 7-day rolling split of playbook starts
 * by SOURCE: Sol's session choice (`sol:session-chose-playbook:{slug}`) vs the deterministic
 * signal matcher (`sol:matcher-chose-playbook:{slug}`).
 *
 * Phase 4 of docs/brain/specs/sol-session-chosen-playbook-selection-retire-brittle-triggers.md.
 * Powers the "Session-chosen vs signal-matched playbook selection" tile at
 * /dashboard/tickets/analytics (below the existing selective-clarify-rate tile). Read-only —
 * the reasoning column on ticket_resolution_events is the ONLY source; no new table needed.
 * Owner / admin / cs_manager only. See docs/brain/tables/ticket_resolution_events.md § Read paths.
 *
 * Response:
 * {
 *   window_days: 7,
 *   total_session_chosen: number,
 *   total_matcher_chosen: number,
 *   per_slug: Record<string, { session_chosen: number; matcher_chosen: number }>
 * }
 *
 * The per_slug object is keyed by playbook slug (the `{slug}` half of the reasoning string).
 * Callers that want a "top-5 slug split" render pattern can sort per_slug entries by
 * (session_chosen + matcher_chosen) desc and slice — the route returns the full map so
 * downstream consumers can pick their own cut.
 */
import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

const ALLOWED_ROLES = ["owner", "admin", "cs_manager"];

const SESSION_PREFIX = "sol:session-chose-playbook:";
const MATCHER_PREFIX = "sol:matcher-chose-playbook:";

/** Pure aggregator — exported so the unit test can exercise the reasoning-string parsing
 * without spinning up a fake Supabase client. Returns the exact response shape. */
export function aggregatePlaybookSelectionSplit(
  reasoningRows: Array<{ reasoning: string | null }>,
): {
  total_session_chosen: number;
  total_matcher_chosen: number;
  per_slug: Record<string, { session_chosen: number; matcher_chosen: number }>;
} {
  const perSlug: Record<string, { session_chosen: number; matcher_chosen: number }> = {};
  let totalSession = 0;
  let totalMatcher = 0;
  for (const r of reasoningRows) {
    const raw = r.reasoning;
    if (typeof raw !== "string") continue;
    let source: "session_chosen" | "matcher_chosen" | null = null;
    let slug: string | null = null;
    if (raw.startsWith(SESSION_PREFIX)) {
      source = "session_chosen";
      slug = raw.slice(SESSION_PREFIX.length);
    } else if (raw.startsWith(MATCHER_PREFIX)) {
      source = "matcher_chosen";
      slug = raw.slice(MATCHER_PREFIX.length);
    }
    if (!source || !slug) continue;
    const bucket = perSlug[slug] ?? { session_chosen: 0, matcher_chosen: 0 };
    bucket[source] += 1;
    perSlug[slug] = bucket;
    if (source === "session_chosen") totalSession += 1;
    else totalMatcher += 1;
  }
  return {
    total_session_chosen: totalSession,
    total_matcher_chosen: totalMatcher,
    per_slug: perSlug,
  };
}

export async function GET() {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !ALLOWED_ROLES.includes(member.role)) {
    return NextResponse.json({ error: "Owner, admin, or CS manager role required" }, { status: 403 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Postgres LIKE narrows the read to just the two reasoning-prefixed rows the tile splits by,
  // so the workspace-wide read stays cheap even on high-throughput workspaces. The workspace_id
  // eq is the primary partition; staged_at gte is the window filter.
  const { data: rows } = await admin
    .from("ticket_resolution_events")
    .select("reasoning")
    .eq("workspace_id", workspaceId)
    .gte("staged_at", since)
    .or(`reasoning.like.${SESSION_PREFIX}%,reasoning.like.${MATCHER_PREFIX}%`);

  const aggregate = aggregatePlaybookSelectionSplit(
    (rows ?? []) as Array<{ reasoning: string | null }>,
  );

  return NextResponse.json({
    window_days: 7,
    ...aggregate,
  });
}
