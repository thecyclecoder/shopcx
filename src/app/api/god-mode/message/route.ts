/**
 * POST /api/god-mode/message — the dashboard-tab equivalent of /api/god/[token]/message.
 *
 * Phase 4 of docs/brain/specs/god-mode.md. Owner-gated. Resolves the
 * workspace's active session server-side (no token trip through the client),
 * appends the founder turn, and enqueues a kind='god-mode' mode:'turn' job.
 *
 * Body: { message: string }.
 * 400 on empty; 404 when nothing is armed; 200 { ok:true, job_id } on success.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getActiveSession,
  appendMessage,
  enqueueGodModeTurn,
  bumpActivity,
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

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as { message?: string };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });

  const session = await getActiveSession(admin, workspaceId);
  if (!session) return NextResponse.json({ error: "not_armed" }, { status: 404 });

  await appendMessage(admin, session.id, {
    role: "user",
    content: message,
    ts: new Date().toISOString(),
  });

  const { jobId } = await enqueueGodModeTurn(admin, {
    workspaceId,
    sessionId: session.id,
    userMessage: message,
    createdBy: user.id,
  });

  await bumpActivity(admin, session.id);
  return NextResponse.json({ ok: true, job_id: jobId });
}
