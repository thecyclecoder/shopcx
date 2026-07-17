/**
 * POST /api/god-mode/arm — the founder ARMS the god-mode session.
 *
 * Phase 1 of docs/brain/specs/god-mode.md — mints a cockpit token, sets the
 * sliding + absolute TTLs, and returns the /god/{token} URL the founder taps
 * from the SMS (or from the in-app tab in Phase 4). Owner-gated (mirror
 * src/app/api/developer/messages/route.ts:31-45) — non-owners get 401/403 and
 * NO row lands (verification requirement).
 *
 * The write itself goes through the god-mode SDK chokepoint (armSession) —
 * this route only owns owner-gating + shaping the response.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { armSession, cockpitUrl } from "@/lib/god-mode";

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
    return { error: NextResponse.json({ error: "Only the workspace owner can arm god mode" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

export async function POST(req: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId, admin } = auth;

  // Optional { resumeSessionId } — revive a past chat instead of starting fresh.
  let resumeSessionId: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { resumeSessionId?: unknown };
    if (typeof body.resumeSessionId === "string" && body.resumeSessionId) resumeSessionId = body.resumeSessionId;
  } catch { /* no body — fresh arm */ }

  const session = await armSession(admin, { workspaceId, createdBy: user.id, resumeSessionId });
  if (!session.cockpit_token) {
    // Cannot happen — armSession() always mints a token — but guard so the
    // response contract is honest if the SDK evolves.
    return NextResponse.json({ error: "arm failed" }, { status: 500 });
  }
  return NextResponse.json({
    session: {
      id: session.id,
      status: session.status,
      cockpit_token: session.cockpit_token,
      token_expires_at: session.token_expires_at,
      absolute_expires_at: session.absolute_expires_at,
    },
    cockpit_url: cockpitUrl(session.cockpit_token),
  });
}
