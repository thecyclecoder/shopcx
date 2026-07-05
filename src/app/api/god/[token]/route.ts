/**
 * GET /api/god/[token] — the cockpit's read path.
 *
 * Phase 3 of docs/brain/specs/god-mode.md. Token IS the auth (no cookie, no
 * user; matches src/app/api/journey/[token]/route.ts). Returns the transcript +
 * the approvals list + the session status so the cockpit's Chat + Approvals
 * tabs render off one call. Bumps the sliding TTL + last_activity_at (the
 * Phase-5 in-flight signal) so an open cockpit stays live.
 *
 *   • unknown token / disarmed → 404
 *   • expired (past sliding OR absolute TTL) → 410
 *   • armed → 200 { status: 'armed', messages, approvals, expires_at, absolute_expires_at }
 *
 * NEVER exposes workspace_id, user id, cockpit_token (that IS the token — the
 * client already has it), box_session_id, or box_session_config_dir. The
 * cockpit is public-with-a-secret; treat everything under it as PII-adjacent.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveCockpitToken,
  listApprovalsForSession,
  listStandingGrants,
  bumpActivity,
  type GodModeApprovalRow,
  type GodModeMessage,
} from "@/lib/god-mode";

function publicApproval(a: GodModeApprovalRow) {
  return {
    id: a.id,
    tool_name: a.tool_name,
    preview: a.preview,
    risk: a.risk,
    status: a.status,
    category: a.category,
    question_text: a.question_text,
    created_at: a.created_at,
    decided_at: a.decided_at,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  void request;
  const { token } = await params;
  const admin = createAdminClient();

  const res = await resolveCockpitToken(admin, token);
  if (res.kind === "not_found" || res.kind === "disarmed") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (res.kind === "expired") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  // Slide TTL + bump last_activity_at BEFORE reading approvals so a stale-idle
  // reaper (Phase 5) never races an open cockpit into expiry mid-response.
  await bumpActivity(admin, res.session.id);

  const approvals = await listApprovalsForSession(admin, res.session.id);
  const standingGrants = await listStandingGrants(admin, res.session.workspace_id);
  const messages: GodModeMessage[] = Array.isArray(res.session.messages) ? res.session.messages : [];

  return NextResponse.json({
    status: res.session.status,
    messages,
    approvals: approvals.map(publicApproval),
    standingGrants: standingGrants.map((g) => ({ category: g.category, created_at: g.created_at })),
    // Sliding + absolute — the cockpit renders a "session ends at" hint so the
    // founder knows when to re-arm.
    token_expires_at: res.session.token_expires_at,
    absolute_expires_at: res.session.absolute_expires_at,
  });
}
