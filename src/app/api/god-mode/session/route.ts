/**
 * GET /api/god-mode/session — the in-app dashboard tab's read path.
 *
 * Phase 4 of docs/brain/specs/god-mode.md. Owner-gated (mirrors
 * src/app/api/developer/messages/route.ts requireOwner). Resolves the
 * workspace's active god_mode_sessions row server-side — the client never
 * sees the cockpit_token; the token stays reserved for the /god/[token] SMS
 * cockpit (matching the "never trust the client" mandate in the spec).
 *
 * Returns { armed:false } when nothing is armed (the tab renders the Arm
 * button). Returns { armed:true, session, messages, approvals } when armed —
 * SAME public shape as GET /api/god/[token] so the shared client component
 * can render either payload.
 *
 * Bumps the sliding TTL + last_activity_at on every read (same in-flight
 * signal the cockpit uses — a dashboard tab open on the tab counts as
 * activity, same as an open cockpit page).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getActiveSession,
  listApprovalsForSession,
  listStandingGrants,
  listPastSessions,
  bumpActivity,
  type GodModeApprovalRow,
  type GodModeMessage,
} from "@/lib/god-mode";

async function requireOwner() {
  const { user } = await getAuthedUser();
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
    category: a.category,
    question_text: a.question_text,
    created_at: a.created_at,
    decided_at: a.decided_at,
  };
}

export async function GET() {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { workspaceId, admin } = auth;

  const session = await getActiveSession(admin, workspaceId);
  if (!session) {
    // Nothing armed — offer past chats to resume alongside the Chat-with-Eve button.
    const pastSessions = await listPastSessions(admin, workspaceId);
    return NextResponse.json({ armed: false, pastSessions });
  }

  await bumpActivity(admin, session.id);
  const approvals = await listApprovalsForSession(admin, session.id);
  const standingGrants = await listStandingGrants(admin, workspaceId);
  const messages: GodModeMessage[] = Array.isArray(session.messages) ? session.messages : [];

  return NextResponse.json({
    armed: true,
    session: {
      id: session.id,
      status: session.status,
      token_expires_at: session.token_expires_at,
      absolute_expires_at: session.absolute_expires_at,
      armed_at: session.armed_at,
    },
    messages,
    approvals: approvals.map(publicApproval),
    standingGrants: standingGrants.map((g) => ({ category: g.category, created_at: g.created_at })),
  });
}
