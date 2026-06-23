/**
 * /api/developer/agents/activity — a director's live activity feed (director observability).
 *
 * Owner-gated, read-only. `GET ?fn=<director_function>` returns { activity: DirectorActivityEntry[] } —
 * the director's own `director_activity` rows (every autonomous action it took: auto-approved,
 * escorted a goal/spec, coached a worker, escalated to the CEO), newest-first. Backs the "Recent
 * activity" section on the director's profile page (/dashboard/agents/[role]) so the operator can see
 * the director is alive + exactly what it's doing autonomously.
 *
 * See docs/brain/tables/director_activity.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const fn = new URL(req.url).searchParams.get("fn");
  if (!fn) return NextResponse.json({ error: "Missing ?fn" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

  const { data } = await admin
    .from("director_activity")
    .select("id, action_kind, spec_slug, reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("director_function", fn)
    .order("created_at", { ascending: false })
    .limit(50);

  const activity = (data || []).map((r) => ({
    id: r.id as string,
    actionKind: r.action_kind as string,
    specSlug: (r.spec_slug as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
  return NextResponse.json({ activity });
}
