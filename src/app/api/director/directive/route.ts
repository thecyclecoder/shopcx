/**
 * /api/director/directive — the hub/profile surface for a director's active directive
 * ([[../../../../docs/brain/specs/director-executable-plans-and-priority-hub-pip]] Phase 1).
 *
 *   GET ?function=platform                  → { directive: DirectorDirective | null }
 *   POST { id, action:"clear" }              → CEO terminates the active directive (no ship)
 *
 * Owner-gated, workspace-scoped. The directive store + lifecycle live in
 * [[../../../../docs/brain/libraries/director-directives]] — this route is the dashboard read +
 * the clear affordance behind the dedicated card on /dashboard/agents + the platform profile.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { clearDirective, getActiveDirective } from "@/lib/agents/director-directives";
import { recordDirectorActivity } from "@/lib/director-activity";


const DEFAULT_DIRECTOR = "platform";

async function gate(): Promise<{ ok: false; res: NextResponse } | { ok: true; workspaceId: string; userId: string }> {
  const { user } = await getAuthedUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { ok: false, res: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return { ok: false, res: NextResponse.json({ error: "Owner only" }, { status: 403 }) };
  }
  return { ok: true, workspaceId, userId: user.id };
}

export async function GET(req: Request) {
  const g = await gate();
  if (!g.ok) return g.res;
  const fn = (new URL(req.url).searchParams.get("function") ?? DEFAULT_DIRECTOR).trim() || DEFAULT_DIRECTOR;
  const admin = createAdminClient();
  const directive = await getActiveDirective(admin, g.workspaceId, fn);
  return NextResponse.json({ directive });
}

export async function POST(req: Request) {
  const g = await gate();
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as { id?: string; action?: string };
  if (body.action !== "clear") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("director_directives")
    .select("id, workspace_id, director_function, summary, gate_builds_until, status")
    .eq("id", id)
    .eq("workspace_id", g.workspaceId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Directive not found" }, { status: 404 });
  if (row.status !== "active") {
    return NextResponse.json({ error: `Directive is ${row.status} — nothing to clear` }, { status: 409 });
  }
  const r = await clearDirective(admin, g.workspaceId, id);
  if (!r.ok) return NextResponse.json({ error: "Failed to clear directive" }, { status: 500 });
  await recordDirectorActivity(admin, {
    workspaceId: g.workspaceId,
    directorFunction: (row.director_function as string) ?? DEFAULT_DIRECTOR,
    actionKind: "directive_cleared",
    specSlug: (row.gate_builds_until as string | null) ?? null,
    reason: `CEO cleared the active directive — ${(row.summary as string) ?? ""}`.slice(0, 4000),
    metadata: { directive_id: id, gate_builds_until: (row.gate_builds_until as string | null) ?? null, cleared_by: "owner" },
  });
  return NextResponse.json({ ok: true, cleared: r.cleared });
}
