import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET — list proposed handler aliases for a workspace, filtered by status.
// Also returns the currently-active alias catalog (globals + workspace
// overrides) so the admin surface can render both together.
//
// Authz: mirrors the sibling PATCH at [proposalId]/route.ts:22-27 — after
// the auth check, look up workspace_members by (workspace_id, user_id) and
// require an owner/admin role. Without this the URL-path workspaceId is
// used as the .eq filter for admin-client (service-role) reads, letting an
// authenticated user read any workspace's aliases (cross-tenant IDOR).
// UUID guard: reject a non-UUID workspaceId with 400 so it cannot be
// interpolated into the .or() PostgREST filter string on line ~30.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  if (!UUID_RE.test(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const status = req.nextUrl.searchParams.get("status"); // 'pending' | 'approved' | 'declined' | null (= all)

  let q = admin.from("proposed_action_aliases")
    .select("id, source_type, ticket_id, occurrences, first_seen, last_seen, suggested_target, suggested_at, suggested_model, suggested_reasoning, status, reviewed_at, created_at")
    .eq("workspace_id", workspaceId)
    .order("last_seen", { ascending: false });

  if (status) q = q.eq("status", status);

  const { data: proposals, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: aliases } = await admin.from("action_handler_aliases")
    .select("id, workspace_id, source_type, target_type, active, created_at")
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .order("source_type", { ascending: true });

  return NextResponse.json({ proposals: proposals || [], aliases: aliases || [] });
}
