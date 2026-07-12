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
  listApprovalsForSession,
  listStandingGrants,
  bumpActivity,
  type GodModeApprovalRow,
  type GodModeMessage,
} from "@/lib/god-mode";
import { resolveCockpitTokenAny } from "@/lib/cockpit-resolver";
import { PERSONAS } from "@/lib/agents/personas";

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

  // director-sms-cockpit-per-director Phase 2: route through the two-token
  // resolver — an Eve token yields the existing god-mode payload (byte-for-byte
  // unchanged from main other than the added `kind:'god'` discriminator); a
  // director token yields the director cockpit payload the /god/[token] page
  // renders under the director's persona accent + leash subheader.
  const resolved = await resolveCockpitTokenAny(admin, token);
  if (!resolved) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (resolved.kind === "god") {
    // Slide TTL + bump last_activity_at BEFORE reading approvals so a stale-idle
    // reaper (Phase 5) never races an open cockpit into expiry mid-response.
    await bumpActivity(admin, resolved.session.id);
    const approvals = await listApprovalsForSession(admin, resolved.session.id);
    const standingGrants = await listStandingGrants(admin, resolved.session.workspace_id);
    const messages: GodModeMessage[] = Array.isArray(resolved.session.messages) ? resolved.session.messages : [];
    return NextResponse.json({
      kind: "god",
      status: resolved.session.status,
      messages,
      approvals: approvals.map(publicApproval),
      standingGrants: standingGrants.map((g) => ({ category: g.category, created_at: g.created_at })),
      // Sliding + absolute — the cockpit renders a "session ends at" hint so the
      // founder knows when to re-arm.
      token_expires_at: resolved.session.token_expires_at,
      absolute_expires_at: resolved.session.absolute_expires_at,
    });
  }

  // Director branch — the cockpit-resolver already rejected an expired token
  // (director_coach_threads.token_expires_at / absolute_expires_at) before
  // returning `{ kind:'director' }`. No TTL slide here yet — mirrors the
  // Eve-side discipline where a read bumps activity; the director thread's
  // updated_at bump on the next `markThreadThinking` is enough for now (the
  // cockpit is polling every 2.5s so activity signal is not scarce).
  const thread = resolved.thread;
  const persona = PERSONAS[thread.director_function] as { name?: string; accent?: string; role?: string } | undefined;
  return NextResponse.json({
    kind: "director",
    thread: {
      id: thread.id,
      director_function: thread.director_function,
      messages: thread.messages,
      pending_actions: thread.pending_actions,
      turn_status: thread.turn_status,
      title: thread.title,
    },
    persona: {
      name: (persona?.name ?? "").trim() || thread.director_function,
      accent: persona?.accent ?? "",
      role: persona?.role ?? "",
    },
    expires_at: thread.token_expires_at,
    absolute_expires_at: thread.absolute_expires_at,
  });
}
