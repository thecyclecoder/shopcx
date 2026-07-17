/**
 * /api/developer/agents/activity — a director's (or worker's) live activity feed.
 *
 * Owner-gated, read-only. `GET ?fn=<director_function>` returns { activity: DirectorActivityEntry[] } —
 * the supervising director's `director_activity` rows (every autonomous action it took: auto-approved,
 * escorted a goal/spec, coached a worker, escalated to the CEO), newest-first. Backs the "Recent
 * activity" section on the director's profile page (/dashboard/agents/[role]).
 *
 * `&actor=<actor>` narrows to rows whose `metadata.actor` matches — used by a worker profile to show
 * ONLY that worker's rows (e.g. Reva's deploy_rolled_back actions filed under the platform director).
 * Mirrors the actor-tagging convention (`actor: "deploy-guardian"`, `actor: "reconciler:spec-drift"`).
 *
 * See docs/brain/tables/director_activity.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";


export async function GET(req: Request) {
  const url = new URL(req.url);
  const fn = url.searchParams.get("fn");
  const actor = url.searchParams.get("actor");
  if (!fn) return NextResponse.json({ error: "Missing ?fn" }, { status: 400 });

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
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view director activity" }, { status: 403 });
  }

  let query = admin
    .from("director_activity")
    .select("id, action_kind, spec_slug, reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("director_function", fn);
  // Worker scoping: narrow to rows whose metadata.actor matches (PostgREST jsonb -> text op).
  if (actor) query = query.eq("metadata->>actor", actor);
  const { data } = await query.order("created_at", { ascending: false }).limit(50);

  // director-dismiss-park-and-short-circuit-spec Phase 1: a `dismissed_park` row carries the parked
  // job's id in metadata so the activity feed can render a Re-open button. The button hides once a
  // `reopened_park` row for the SAME job_id lands (i.e. the CEO already re-opened it).
  const rows = (data || []) as Array<{
    id: string;
    action_kind: string;
    spec_slug: string | null;
    reason: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  const reopenedJobIds = new Set<string>();
  for (const r of rows) {
    if (r.action_kind === "reopened_park") {
      const jid = (r.metadata as Record<string, unknown> | null)?.["job_id"];
      if (typeof jid === "string") reopenedJobIds.add(jid);
    }
  }

  const activity = rows.map((r) => {
    const meta = r.metadata ?? {};
    const jobId = typeof meta["job_id"] === "string" ? (meta["job_id"] as string) : null;
    const reopenable = r.action_kind === "dismissed_park" && !!jobId && !reopenedJobIds.has(jobId);
    return {
      id: r.id,
      actionKind: r.action_kind,
      specSlug: r.spec_slug ?? null,
      reason: r.reason ?? null,
      createdAt: r.created_at,
      jobId,
      reopenable,
    };
  });
  return NextResponse.json({ activity });
}
