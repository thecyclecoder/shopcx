import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { settleParkedJobOnDismiss } from "@/lib/agents/approval-inbox";

/**
 * Tenant-isolation guard. These handlers use the service-role admin client (RLS bypassed), so they
 * MUST verify the caller belongs to the `[id]` workspace themselves — otherwise a user authenticated
 * to workspace A could read/dismiss workspace B's notifications and (via the dismiss → settle path)
 * cancel B's pending agent approvals and settle B's parked jobs. Matches the sibling-route convention
 * under src/app/api/workspaces/[id]/ (e.g. fraud-rules/[ruleId]/route.ts).
 */
async function isWorkspaceMember(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { data: member } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!member;
}

// GET: Single notification detail
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; notificationId: string }> }
) {
  const { id: workspaceId, notificationId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  if (!(await isWorkspaceMember(admin, workspaceId, user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { data } = await admin
    .from("dashboard_notifications")
    .select("*")
    .eq("id", notificationId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

// PATCH: Mark single notification as read or dismissed
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; notificationId: string }> }
) {
  const { id: workspaceId, notificationId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const admin = createAdminClient();
  if (!(await isWorkspaceMember(admin, workspaceId, user.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updates: Record<string, boolean> = {};
  if (body.read !== undefined) updates.read = !!body.read;
  if (body.dismissed !== undefined) updates.dismissed = !!body.dismissed;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: patched } = await admin
    .from("dashboard_notifications")
    .update(updates)
    .eq("id", notificationId)
    .eq("workspace_id", workspaceId)
    .select("workspace_id, metadata");

  // When this PATCH dismisses the card, settle the parked job behind it so the backstop sweep never
  // re-mints it (dismissing-a-park-card-closes-its-job Phase 1). Best-effort; the dismiss still lands.
  if (updates.dismissed === true) {
    const row = (patched ?? [])[0];
    if (row) await settleParkedJobOnDismiss(admin, { workspace_id: row.workspace_id, metadata: row.metadata });
  }

  return NextResponse.json({ ok: true });
}
