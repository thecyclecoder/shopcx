/**
 * /api/developer/messages — the Developer > Message Center (developer-message-center).
 *
 * A founder-facing, read-only "ask the box anything" console. This route NEVER calls the Anthropic API:
 * each turn enqueues a `kind='dev-ask'` agent_jobs row that the build box claims and runs as a
 * long-running, resumable `claude -p` session on Max (whole brain + full repo + read-only prod DB +
 * WebSearch). The route appends the user message, flips the thread to `turn_status='thinking'`, and
 * enqueues the turn; the box appends the reply (the UI polls GET ?id= until idle).
 *
 *   POST action "chat" (default): { id?, message } → enqueue {mode:'turn'} → { thread }
 *   POST action "retry":          { id }           → re-enqueue the last turn (resume)
 *   POST action "approve":        { id, actionId, decision } → record decision; on approve enqueue {mode:'approve_action'}
 *   GET  ?id=<uuid> → load one thread
 *   GET  (no params) → recent threads for the user/workspace (resume list)
 *
 * Owner-gated + workspace-scoped. The box generates; the worker (runDeveloperMessageJob, deterministic
 * Node code holding prod creds) executes any approved card. See docs/brain/specs/developer-message-center.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createThread,
  loadThread,
  markThreadThinking,
  setActionDecision,
  listRecentThreads,
} from "@/lib/dev-message-threads";

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
    return { error: NextResponse.json({ error: "Only the workspace owner can use the message center" }, { status: 403 }) };
  }
  return { user, workspaceId, admin };
}

/** Is a dev-ask job for this thread already in flight? (belt-and-suspenders over the UI's disable.) */
async function hasActiveDevAskJob(admin: ReturnType<typeof createAdminClient>, threadId: string): Promise<boolean> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("kind", "dev-ask")
    .eq("spec_slug", threadId)
    .in("status", ["queued", "queued_resume", "building"])
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/** Enqueue one dev-ask turn/approve_action job. spec_slug labels the row with the thread id. */
async function enqueueDevAsk(
  admin: ReturnType<typeof createAdminClient>,
  opts: { workspaceId: string; userId: string; threadId: string; mode: "turn" | "approve_action" },
) {
  await admin.from("agent_jobs").insert({
    workspace_id: opts.workspaceId,
    kind: "dev-ask",
    spec_slug: opts.threadId,
    status: "queued",
    instructions: JSON.stringify({ thread_id: opts.threadId, mode: opts.mode }),
    created_by: opts.userId,
  });
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;
  const { user, workspaceId, admin } = auth;

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    action?: "chat" | "retry" | "approve";
    actionId?: string;
    decision?: "approve" | "decline";
  };
  const action = body.action ?? "chat";

  // ── approve — record the owner's decision on one pending card; on approve enqueue the executor turn. ──
  if (action === "approve") {
    if (!body.id || !body.actionId || (body.decision !== "approve" && body.decision !== "decline")) {
      return NextResponse.json({ error: "id, actionId, decision required" }, { status: 400 });
    }
    const thread = await setActionDecision(workspaceId, body.id, body.actionId, body.decision);
    if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });
    if (body.decision === "approve") {
      await enqueueDevAsk(admin, { workspaceId, userId: user.id, threadId: body.id, mode: "approve_action" });
    }
    return NextResponse.json({ thread });
  }

  // ── chat / retry — resolve or create the thread, append the message, enqueue a turn. ──
  let threadId = typeof body.id === "string" && body.id ? body.id : undefined;
  let createdWithMessage = false;
  if (!threadId) {
    if (action !== "chat" || !body.message?.trim()) {
      return NextResponse.json({ error: "thread id required" }, { status: 400 });
    }
    const created = await createThread({ workspaceId, userId: user.id, message: body.message.trim() });
    if (!created) return NextResponse.json({ error: "could not start thread" }, { status: 500 });
    threadId = created.id;
    createdWithMessage = true;
  }

  const existing = await loadThread(workspaceId, threadId);
  if (!existing) return NextResponse.json({ error: "thread not found" }, { status: 404 });

  // Don't double-enqueue while a turn is already on the box (the UI disables, but guard anyway).
  if (existing.turn_status === "thinking" && (await hasActiveDevAskJob(admin, threadId))) {
    return NextResponse.json({ thread: existing });
  }

  const userMessage = action === "retry" || createdWithMessage ? undefined : body.message?.trim();
  if (action === "chat" && !createdWithMessage && !userMessage) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }
  const thread = await markThreadThinking(workspaceId, threadId, userMessage);
  await enqueueDevAsk(admin, { workspaceId, userId: user.id, threadId, mode: "turn" });
  return NextResponse.json({ thread });
}

export async function GET(request: Request) {
  const auth = await requireOwner();
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const thread = await loadThread(auth.workspaceId, id);
    return NextResponse.json({ thread });
  }
  const threads = await listRecentThreads(auth.workspaceId, auth.user.id);
  return NextResponse.json({ threads });
}
