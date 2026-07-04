/**
 * POST /api/god-mode/approve — the dashboard-tab equivalent of /api/god/[token]/approve.
 *
 * Phase 4 of docs/brain/specs/god-mode.md. Owner-gated. Resolves the
 * workspace's active session server-side, then terminal-flips one approval
 * row bound to THAT session (tamper-guard against a client passing an
 * approvalId from another workspace — 404 on mismatch, never 403 to avoid
 * confirming existence elsewhere).
 *
 * Body: { approvalId, decision:'approve'|'deny'|'ask', question?, pin? }.
 * `approve` of risk='destructive' verifies PIN via constant-time verifyPin
 * against workspaces.god_mode_pin_hash — SAME behavior as the cockpit route.
 * Idempotent on already-terminal rows.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getActiveSession,
  getApprovalForSession,
  decideApproval,
  bumpActivity,
  loadPinHash,
  verifyPin,
  type GodModeApprovalRow,
} from "@/lib/god-mode";

async function requireOwner() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return { error: NextResponse.json({ error: "No workspace" }, { status: 400 }) };
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return { error: NextResponse.json({ error: "Only the workspace owner can use god mode" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

function publicApproval(a: GodModeApprovalRow) {
  return {
    id: a.id,
    tool_name: a.tool_name,
    preview: a.preview,
    risk: a.risk,
    status: a.status,
    question_text: a.question_text,
    created_at: a.created_at,
    decided_at: a.decided_at,
  };
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    approvalId?: string;
    decision?: string;
    question?: string;
    pin?: string;
  };

  const decision = body.decision;
  if (!body.approvalId || (decision !== "approve" && decision !== "deny" && decision !== "ask")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const questionText = typeof body.question === "string" ? body.question.trim() : "";
  if (decision === "ask" && !questionText) {
    return NextResponse.json({ error: "question_required" }, { status: 400 });
  }

  const session = await getActiveSession(admin, workspaceId);
  if (!session) return NextResponse.json({ error: "not_armed" }, { status: 404 });

  const existing = await getApprovalForSession(admin, {
    approvalId: body.approvalId,
    sessionId: session.id,
  });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (existing.status !== "pending") {
    await bumpActivity(admin, session.id);
    return NextResponse.json({ ok: true, approval: publicApproval(existing) });
  }

  if (decision === "approve" && existing.risk === "destructive") {
    const stored = await loadPinHash(admin, workspaceId);
    if (!stored) return NextResponse.json({ error: "pin_not_set" }, { status: 401 });
    if (!verifyPin(typeof body.pin === "string" ? body.pin : "", stored)) {
      return NextResponse.json({ error: "pin_incorrect" }, { status: 401 });
    }
  }

  const updated = await decideApproval(admin, {
    approvalId: body.approvalId,
    decision,
    questionText: decision === "ask" ? questionText : undefined,
  });

  await bumpActivity(admin, session.id);
  return NextResponse.json({
    ok: true,
    approval: updated ? publicApproval(updated) : publicApproval(existing),
  });
}
