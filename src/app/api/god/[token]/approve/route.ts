/**
 * POST /api/god/[token]/approve — the founder decides one approval.
 *
 * Phase 3 of docs/brain/specs/god-mode.md. Terminal-flip a `god_mode_approvals`
 * row bound to THIS session (tamper-guard: the approval's session_id must match
 * the token's session, else 404 — never leak whether the id exists elsewhere).
 *
 * Body: { approvalId: string, decision: 'approve'|'deny'|'ask', question?: string, pin?: string }
 *   • approve of risk='destructive' → verify `pin` against workspaces.god_mode_pin_hash
 *     via verifyPin() (constant-time). On mismatch: 401 { error: 'pin_incorrect' } and NO
 *     row change (never reveal validity beyond allow/deny). No PIN required for risk='write'.
 *   • deny  → status='denied'
 *   • ask   → status='asked'; question_text required (min 1 non-whitespace char)
 *
 * The Phase-2 box gate is polling god_mode_approvals every 2s; the flip written
 * here is what unblocks (or blocks) the tool call. Renews TTL + bumps
 * last_activity_at on every call — an approve/deny/ask is definitely activity.
 *
 * 404 on unknown/disarmed token OR when the approval id doesn't belong to this
 * session; 410 on expired; 400 on malformed body; 401 on PIN mismatch; 200
 * with { ok: true, approval } on success.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveCockpitToken,
  getApprovalForSession,
  decideApproval,
  bumpActivity,
  loadPinHash,
  verifyPin,
  type GodModeApprovalRow,
} from "@/lib/god-mode";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
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

  const admin = createAdminClient();
  const res = await resolveCockpitToken(admin, token);
  if (res.kind === "not_found" || res.kind === "disarmed") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (res.kind === "expired") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Tamper-guard: the approval MUST belong to the token's session. A caller
  // guessing an approvalId from another workspace gets a 404 (never a 403 —
  // 403 would confirm the id exists somewhere).
  const existing = await getApprovalForSession(admin, {
    approvalId: body.approvalId,
    sessionId: res.session.id,
  });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Already terminal — return the row unchanged (idempotent; the cockpit may
  // double-fire under a slow network).
  if (existing.status !== "pending") {
    await bumpActivity(admin, res.session.id);
    return NextResponse.json({ ok: true, approval: publicApproval(existing) });
  }

  // Destructive approve → PIN gate. Verified against the STORED HASH via
  // constant-time verifyPin(); we never see plaintext beyond this line.
  if (decision === "approve" && existing.risk === "destructive") {
    const stored = await loadPinHash(admin, res.session.workspace_id);
    if (!stored) {
      // No PIN was ever set — refuse the destructive approve. Otherwise a
      // workspace where nobody ran _set-god-mode-pin.ts would silently accept
      // "any pin" (verifyPin('', null) === false, so the branch below still
      // rejects, but this branch surfaces the diagnosis).
      return NextResponse.json({ error: "pin_not_set" }, { status: 401 });
    }
    if (!verifyPin(typeof body.pin === "string" ? body.pin : "", stored)) {
      return NextResponse.json({ error: "pin_incorrect" }, { status: 401 });
    }
  }

  const updated = await decideApproval(admin, {
    approvalId: body.approvalId,
    decision,
    questionText: decision === "ask" ? questionText : undefined,
  });

  await bumpActivity(admin, res.session.id);

  return NextResponse.json({
    ok: true,
    approval: updated ? publicApproval(updated) : publicApproval(existing),
  });
}
