/**
 * POST /api/developer/agents/inbox/dismiss — owner dismisses an inbox notification by id.
 *
 * Manual companion to reconcileApprovalInbox's auto-dismiss: the reconciler only reaps a request whose
 * agent_jobs row left needs_approval, so a STANDALONE escalation (no agent_job_id — a grooming "your call",
 * a loop-guard diagnosis) never clears on its own, and a request the CEO already decided ON THE FULL SURFACE
 * stays until the job flips. This lets the owner clear either. Owner-gated; scoped to the active workspace
 * and the reserved agent_* inbox types so it can only dismiss agent-hub notifications.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AGENT_INBOX_TYPES } from "@/lib/agents/inbox";
import { settleParkedJobOnDismiss } from "@/lib/agents/approval-inbox";


export async function POST(req: Request) {
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
    return NextResponse.json({ error: "Only the workspace owner can dismiss inbox items" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: dismissed, error } = await admin
    .from("dashboard_notifications")
    .update({ dismissed: true })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .in("type", AGENT_INBOX_TYPES)
    .select("workspace_id, metadata");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // A dismiss means "this is handled" — settle the parked job behind the card so the backstop sweep
  // never re-mints it (dismissing-a-park-card-closes-its-job Phase 1). Best-effort; the card is cleared.
  const row = (dismissed ?? [])[0];
  if (row) await settleParkedJobOnDismiss(admin, { workspace_id: row.workspace_id, metadata: row.metadata });
  return NextResponse.json({ ok: true });
}
