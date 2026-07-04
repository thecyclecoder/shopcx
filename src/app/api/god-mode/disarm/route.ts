/**
 * POST /api/god-mode/disarm — the founder KILLS the god-mode session.
 *
 * Phase 1 of docs/brain/specs/god-mode.md. Owner-gated OR authed by the
 * cockpit_token (a cockpit "kill" button hits this without the app cookie).
 * Body: { cockpit_token?: string }. If cookie+owner and no token, disarms the
 * workspace's active session; if a valid token is passed, disarms THAT session
 * regardless of caller identity (the token IS the auth for the cockpit — same
 * pattern as /api/journey/[token]).
 *
 * The write goes through the god-mode SDK chokepoint (disarmSession); this
 * route only owns auth resolution. Idempotent — a session already
 * disarmed/expired returns { status: 'noop' } instead of an error.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { disarmSession, getSessionByToken } from "@/lib/god-mode";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { cockpit_token?: string };
  const admin = createAdminClient();

  // ── Cockpit-token path: the /god/{token} page's kill switch ─────────────
  if (typeof body.cockpit_token === "string" && body.cockpit_token) {
    const session = await getSessionByToken(admin, body.cockpit_token);
    if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (session.status !== "armed") {
      return NextResponse.json({ status: "noop", session: { id: session.id, status: session.status } });
    }
    const disarmed = await disarmSession(admin, { sessionId: session.id });
    return NextResponse.json({
      status: "disarmed",
      session: disarmed
        ? { id: disarmed.id, status: disarmed.status, disarmed_at: disarmed.disarmed_at }
        : null,
    });
  }

  // ── Owner-gated path: the in-app tab (or arm/disarm CLI probes) ─────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });
  const { data: member } = await admin
    .from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can disarm god mode" }, { status: 403 });
  }

  const disarmed = await disarmSession(admin, { workspaceId });
  if (!disarmed) return NextResponse.json({ status: "noop" });
  return NextResponse.json({
    status: "disarmed",
    session: { id: disarmed.id, status: disarmed.status, disarmed_at: disarmed.disarmed_at },
  });
}
