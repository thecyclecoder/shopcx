import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// PATCH — approve or decline a proposed_action_aliases row.
//
// On approve: insert into action_handler_aliases (workspace-scoped, active=true)
// AND flip the proposed row's status to 'approved'. The target_type comes from
// the request body (admin can override the Haiku suggestion) — the API
// validates it's a non-empty string but does NOT look it up against
// directActionHandlers here (that changes on every executor deploy); the
// executor's own resolveAlias→handler check is the terminal guard.
//
// Guard-before-mutation discipline: the .update() re-asserts workspace_id
// and status='pending' so a stale approve from a background tab cannot
// re-open a row an admin has already declined (or double-insert an already-
// approved alias). .select("id") + a strict `not exactly one row updated`
// check reports back if the compare-and-set found no row.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const { id: workspaceId, proposalId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const decision = String(body?.decision || "").trim();
  if (!["approved", "declined"].includes(decision)) {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  // Re-read the row scoped to (id, workspace) so we can verify what we're
  // about to act on — never trust the client to describe it.
  const { data: proposal, error: readErr } = await admin
    .from("proposed_action_aliases")
    .select("id, source_type, suggested_target, status")
    .eq("id", proposalId)
    .eq("workspace_id", workspaceId)
    .single();
  if (readErr || !proposal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (proposal.status !== "pending") {
    return NextResponse.json({ error: "not_pending", status: proposal.status }, { status: 409 });
  }

  const nowIso = new Date().toISOString();

  if (decision === "declined") {
    // Compare-and-set: only mark declined if still pending; the .select("id")
    // asserts exactly one row transitioned.
    const { data: updated, error: updErr } = await admin
      .from("proposed_action_aliases")
      .update({ status: "declined", reviewed_at: nowIso, reviewed_by: user.id, updated_at: nowIso })
      .eq("id", proposalId)
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .select("id");
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    if (!updated || updated.length !== 1) {
      return NextResponse.json({ error: "conflict" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, status: "declined" });
  }

  // decision === "approved" — admin can override the suggested target.
  const target = String(body?.target_type || proposal.suggested_target || "").trim();
  if (!target) {
    return NextResponse.json({ error: "target_type_required" }, { status: 400 });
  }
  if (target === proposal.source_type) {
    return NextResponse.json({ error: "target_equals_source" }, { status: 400 });
  }

  // Insert the workspace-scoped alias (active=true). Uses upsert on the
  // partial unique (workspace_id, source_type) so a workspace re-approving
  // the same source overwrites its own prior mapping instead of erroring.
  const { error: aliasErr } = await admin
    .from("action_handler_aliases")
    .upsert(
      { workspace_id: workspaceId, source_type: proposal.source_type, target_type: target, active: true },
      { onConflict: "workspace_id,source_type" },
    );
  if (aliasErr) return NextResponse.json({ error: aliasErr.message }, { status: 500 });

  // Compare-and-set the proposal row to 'approved'. If someone else beat us
  // to it (racing tab), reject the write — but the alias is already inserted
  // (idempotently via upsert) so the customer-facing behavior converges.
  const { data: updated, error: updErr } = await admin
    .from("proposed_action_aliases")
    .update({ status: "approved", reviewed_at: nowIso, reviewed_by: user.id, updated_at: nowIso })
    .eq("id", proposalId)
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .select("id");
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  if (!updated || updated.length !== 1) {
    return NextResponse.json({ error: "conflict" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, status: "approved", target });
}
